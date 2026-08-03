/**
 * main.c — splayer-audio-engine CLI 入口
 *
 * 用法：
 *   批量模式（默认）：
 *     splayer-audio-engine <输入文件/URL> [选项]
 *     一次性转码，stdout 输出 OGG/Opus 流
 *
 *   交互模式（Phase 3）：
 *     splayer-audio-engine <输入文件/URL> --interactive --control-fd 3 [--fft-fd 4] [选项]
 *     stdin 接收 JSON 控制命令，stdout 输出 OGG/Opus 流，control-fd 输出状态/响应的 JSON 行
 *     --fft-fd 指定的 fd 输出 FFT 频谱 JSON 行
 *
 * stdin 控制命令（JSON，每行一个）：
 *   {"type":"set_eq","gains":[0,1,0,-1,0,0,0,0,0,0],"preamp":0}
 *   {"type":"set_volume","gain":0.8}
 *   {"type":"set_normalization","enabled":true}
 *   {"type":"set_limiter","enabled":true}
 *   {"type":"set_fft","enabled":true}
 *   {"type":"get_status"}
 *
 * control-fd 响应/状态（JSON，每行一个）：
 *   {"type":"ready","version":"0.3.0","duration_ms":234567,"sample_rate":48000,"channels":2}
 *   {"type":"status","position_ms":12345,"duration_ms":234567}
 *   {"type":"done"}
 *   {"type":"error","message":"..."}
 *
 * fft-fd 频谱数据（JSON，每行一个，由 --fft-fd 指定 fd 输出）：
 *   {"type":"fft","bins":128,"data":[-60.0,-55.2,...]}
 */
#define _POSIX_C_SOURCE 200809L
#define _GNU_SOURCE
#include "../include/audio_engine.h"
#include "decoder.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <getopt.h>
#include <unistd.h>
#include <fcntl.h>
#include <signal.h>
#include <time.h>

/* 全局管线指针，供 SIGTERM 处理器优雅关闭 */
static AudioPipeline *g_pipeline = NULL;

/* SIGTERM 处理器：优雅关闭管线而非被终止。
 * 1. decoder_interrupt() 设置 AVIOInterruptCB 标志 — 若 av_read_frame()
 *    正阻塞在磁盘 I/O，FFmpeg 下次检查时立即返回 AVERROR_EXIT。
 * 2. pipeline_signal_shutdown() 设置管线退出标志 — 主循环检测后退出。 */
static void handle_sigterm(int sig) {
    (void)sig;
    decoder_interrupt();
    if (g_pipeline) {
        pipeline_signal_shutdown(g_pipeline);
    }
}

/* ── 简单 JSON 解析辅助（仅处理我们的控制协议格式） ───────────────── */

/** 跳过空白 */
static const char* skip_ws(const char *s) {
    while (*s == ' ' || *s == '\t' || *s == '\n' || *s == '\r') s++;
    return s;
}

/** 在 JSON 字符串中找到键的值，返回值的起始位置 */
static const char* json_find(const char *json, const char *key) {
    char search[128];
    int key_len = (int)strlen(key);
    snprintf(search, sizeof(search), "\"%s\"", key);
    const char *pos = strstr(json, search);
    if (!pos) return NULL;
    return skip_ws(pos + key_len + 2 + 1); /* skip "key": */
}

/** 读取 JSON 字符串值（复制到 buf） */
static int json_get_string(const char *json, const char *key, char *buf, int bufsize) {
    const char *val = json_find(json, key);
    if (!val || *val != '"') return -1;
    val++;
    int i = 0;
    while (*val && *val != '"' && i < bufsize - 1) {
        buf[i++] = *val++;
    }
    buf[i] = '\0';
    return i;
}

/** 读取 JSON 数值 */
static int json_get_number(const char *json, const char *key, double *out) {
    const char *val = json_find(json, key);
    if (!val) return -1;
    char *end;
    *out = strtod(val, &end);
    return (end == val) ? -1 : 0;
}

/** 读取 JSON 布尔 */
static int json_get_bool(const char *json, const char *key, bool *out) {
    const char *val = json_find(json, key);
    if (!val) return -1;
    if (strncmp(val, "true", 4) == 0) { *out = true; return 0; }
    if (strncmp(val, "false", 5) == 0) { *out = false; return 0; }
    return -1;
}

/** 读取 JSON 数组 [n1,n2,...] 到 float 数组 */
static int json_get_float_array(const char *json, const char *key, float *out, int max_count) {
    const char *val = json_find(json, key);
    if (!val || *val != '[') return 0;
    val++;
    int count = 0;
    while (*val && *val != ']' && count < max_count) {
        val = skip_ws(val);
        if (*val == ']' || *val == '\0') break;
        char *end;
        out[count++] = strtof(val, &end);
        val = skip_ws(end);
        if (*val == ',') val++;
    }
    return count;
}

/* ── 输出辅助 ──────────────────────────────────────────────────── */

/** 写入 fd 的辅助函数（带重试） */
static int write_fd(int fd, const char *data, int len) {
    int written = 0;
    while (written < len) {
        int n = (int)write(fd, data + written, len - written);
        if (n <= 0) return -1;
        written += n;
    }
    return written;
}

/** 向 control-fd 写入 JSON 行 */
static int control_send(int fd, const char *json) {
    int len = (int)strlen(json);
    int ret = write_fd(fd, json, len);
    if (ret < 0) return ret;
    return write_fd(fd, "\n", 1);
}

/* ── OutputCallback：写到 stdout ────────────────────────────────── */
static int write_to_stdout(const uint8_t *data, size_t size, void *user)
{
    (void)user;
    size_t written = 0;
    while (written < size) {
        size_t n = fwrite(data + written, 1, size - written, stdout);
        if (n == 0) return -1;
        written += n;
    }
    fflush(stdout);
    return (int)written;
}

/* ── 解析 EQ 增益字符串 ────────────────────────────────────────── */
static int parse_eq_gains(const char *str, float gains[EQ_BANDS])
{
    int count = 0;
    char *copy = strdup(str);
    char *token = strtok(copy, ",");
    while (token && count < EQ_BANDS) {
        gains[count++] = atof(token);
        token = strtok(NULL, ",");
    }
    free(copy);
    return count;
}

static void print_usage(const char *prog)
{
    fprintf(stderr,
        "用法: %s <输入文件/URL> [选项]\n"
        "\n"
        "基本选项:\n"
        "  -b, --bitrate <bps>     Opus 比特率（默认 128000）\n"
        "  -f, --frame-size <ms>   Opus 帧时长（默认 20ms）\n"
        "  -r, --sample-rate <Hz>  输出采样率（默认 48000，Opus 固定）\n"
        "  -c, --channels <n>      输出声道数（默认 2）\n"
        "  -o, --offset <ms>       跳过开头的毫秒数（CUE 分轨，默认 0）\n"
        "\n"
        "Phase 2 音频处理选项:\n"
        "  --eq <gains>            10 段 EQ 增益（dB），逗号分隔，如 \"0,2,0,-1,0,0,0,0,0,0\"\n"
        "  --preamp <dB>           前级增益（dB），默认 0\n"
        "  --normalization         启用响度归一化\n"
        "  --normalization-gain <dB> 预计算响度增益（dB），默认 0\n"
        "  --no-limiter            禁用限幅器\n"
        "  --limiter-threshold <dB> 限幅器阈值（dB），默认 -1.0\n"
        "  --fft                   启用 FFT 频谱分析\n"
        "  --fft-size <n>          FFT 点数（默认 1024）\n"
        "\n"
        "Phase 4 变速变调选项:\n"
        "  --tempo                 启用变速变调\n"
        "  --tempo-speed <x>       播放速度 [0.5-2.0]，默认 1.0\n"
        "  --tempo-pitch <semitones> 音调偏移（半音）[-12-12]，默认 0\n"
        "  --tempo-pitch-sync      保音调模式（默认）\n"
        "\n"
        "Phase 3 交互模式选项:\n"
        "  --interactive           启用交互模式（stdin JSON 控制）\n"
        "  --control-fd <n>        控制协议 fd（默认 3）\n"
        "  --fft-fd <n>            FFT 数据输出 fd（默认 4），需同时启用 --fft\n"
        "  --fft-interval-ms <n>   FFT 推送间隔（默认 100ms）\n"
        "\n"
        "其他:\n"
        "  -h, --help              显示帮助\n"
        "  -v, --version           显示版本\n"
        "\n"
        "输出:\n"
        "  stdout: OGG/Opus 音频流\n"
        "  stderr: 日志信息\n",
        prog);
}

/* ── 处理单条 stdin 控制命令 ───────────────────────────────────── */
static void handle_command(AudioPipeline *p, const char *line, int ctl_fd) {
    char type[64] = {0};
    if (json_get_string(line, "type", type, sizeof(type)) < 0) return;

    if (strcmp(type, "set_eq") == 0) {
        float gains[EQ_BANDS] = {0};
        int n = json_get_float_array(line, "gains", gains, EQ_BANDS);
        if (n > 0) pipeline_set_eq_gains(p, gains);
        double preamp = 0;
        if (json_get_number(line, "preamp", &preamp) == 0) {
            pipeline_set_preamp(p, (float)preamp);
        }
    } else if (strcmp(type, "set_volume") == 0) {
        double vol = 1.0;
        if (json_get_number(line, "gain", &vol) == 0) {
            pipeline_set_volume(p, (float)vol);
        }
    } else if (strcmp(type, "set_normalization") == 0) {
        bool enabled = true;
        if (json_get_bool(line, "enabled", &enabled) == 0) {
            pipeline_set_normalization_enabled(p, enabled);
        }
    } else if (strcmp(type, "set_limiter") == 0) {
        bool enabled = true;
        if (json_get_bool(line, "enabled", &enabled) == 0) {
            pipeline_set_limiter_enabled(p, enabled);
        }
    } else if (strcmp(type, "set_fft") == 0) {
        bool enabled = true;
        if (json_get_bool(line, "enabled", &enabled) == 0) {
            pipeline_set_fft_enabled(p, enabled);
        }
    } else if (strcmp(type, "set_tempo_speed") == 0) {
        double speed = 1.0;
        if (json_get_number(line, "speed", &speed) == 0) {
            pipeline_set_tempo_speed(p, (float)speed);
        }
    } else if (strcmp(type, "set_tempo_pitch") == 0) {
        double semitones = 0.0;
        if (json_get_number(line, "semitones", &semitones) == 0) {
            pipeline_set_tempo_pitch(p, (float)semitones);
        }
    } else if (strcmp(type, "set_tempo") == 0) {
        bool enabled = true;
        if (json_get_bool(line, "enabled", &enabled) == 0) {
            pipeline_set_tempo_enabled(p, enabled);
        }
    } else if (strcmp(type, "get_status") == 0) {
        char buf[256];
        double pos = pipeline_get_position(p);
        double dur = pipeline_get_duration(p);
        snprintf(buf, sizeof(buf),
            "{\"type\":\"status\",\"position_ms\":%.0f,\"duration_ms\":%.0f}",
            pos * 1000.0, dur * 1000.0);
        control_send(ctl_fd, buf);
    }
}

/* ── 交互模式主循环 ────────────────────────────────────────────── */
static int run_interactive(AudioPipeline *p, int ctl_fd, int fft_fd, int fft_interval_ms)
{
    /* 发送就绪消息 */
    char ready[256];
    snprintf(ready, sizeof(ready),
        "{\"type\":\"ready\",\"version\":\"%s\",\"duration_ms\":%.0f,\"sample_rate\":%d,\"channels\":%d}",
        audio_engine_version(),
        pipeline_get_duration(p) * 1000.0,
        pipeline_get_source_sample_rate(p),
        pipeline_get_source_channels(p));
    control_send(ctl_fd, ready);

    /* 设置 stdin 为非阻塞 */
    int flags = fcntl(STDIN_FILENO, F_GETFL, 0);
    fcntl(STDIN_FILENO, F_SETFL, flags | O_NONBLOCK);

    /* stdin 读取缓冲区 */
    char stdin_buf[4096];
    int stdin_pos = 0;

    /* FFT 推送间隔控制 */
    struct timespec last_fft = {0};
    if (fft_fd >= 0) clock_gettime(CLOCK_MONOTONIC, &last_fft);

    /* 主循环：交替处理音频帧 + 检查 stdin 命令 */
    for (;;) {
        /* 处理若干音频帧 */
        ssize_t n = pipeline_process(p);
        if (n < 0) {
            char err_buf[128];
            snprintf(err_buf, sizeof(err_buf),
                "{\"type\":\"error\",\"message\":\"pipeline error %zd\"}", (size_t)n);
            control_send(ctl_fd, err_buf);
            return (int)n;
        }
        if (n == 0) break; /* EOF */

        /* 读取 stdin 命令（非阻塞） */
        for (;;) {
            ssize_t r = read(STDIN_FILENO, stdin_buf + stdin_pos,
                             sizeof(stdin_buf) - stdin_pos - 1);
            if (r <= 0) break; /* 无数据或错误 */
            stdin_pos += r;
            stdin_buf[stdin_pos] = '\0';

            /* 处理完整的行 */
            char *sol = stdin_buf;
            while (1) {
                char *nl = strchr(sol, '\n');
                if (!nl) break;
                *nl = '\0';
                if (nl > sol && *sol != '\0') {
                    handle_command(p, sol, ctl_fd);
                }
                sol = nl + 1;
            }
            /* 保留未完成的行 */
            if (sol > stdin_buf) {
                int leftover = (int)(stdin_buf + stdin_pos - sol);
                if (leftover > 0) {
                    memmove(stdin_buf, sol, leftover);
                }
                stdin_pos = leftover;
                stdin_buf[stdin_pos] = '\0';
            }
        }

        /* FFT 数据定时推送 */
        if (fft_fd >= 0 && pipeline_get_fft_size(p) > 0) {
            struct timespec now;
            clock_gettime(CLOCK_MONOTONIC, &now);
            long elapsed_ms = (now.tv_sec - last_fft.tv_sec) * 1000 +
                              (now.tv_nsec - last_fft.tv_nsec) / 1000000;
            if (elapsed_ms >= fft_interval_ms) {
                int fft_size = pipeline_get_fft_size(p);
                int bins = fft_size / 2 + 1;
                if (bins > 512) bins = 512; /* 限制输出频段数 */
                float fft_data[512];
                float fft_data_r[512];
                pipeline_get_fft_spectrum_stereo(p, fft_data, fft_data_r, bins, -60.0f);

                /* 构造 JSON（双声道独立数据） */
                char fft_json[16384];
                int off = snprintf(fft_json, sizeof(fft_json),
                    "{\"type\":\"fft\",\"bins\":%d,\"ldata\":[", bins);
                for (int i = 0; i < bins; i++) {
                    off += snprintf(fft_json + off, sizeof(fft_json) - off,
                        "%.1f%s", fft_data[i], i < bins - 1 ? "," : "");
                }
                off += snprintf(fft_json + off, sizeof(fft_json) - off, "],\"rdata\":[");
                for (int i = 0; i < bins; i++) {
                    off += snprintf(fft_json + off, sizeof(fft_json) - off,
                        "%.1f%s", fft_data_r[i], i < bins - 1 ? "," : "");
                }
                off += snprintf(fft_json + off, sizeof(fft_json) - off, "]}");

                write_fd(fft_fd, fft_json, off);
                write_fd(fft_fd, "\n", 1);
                last_fft = now;
            }
        }
    }

    /* flush 残留 */
    int ret = pipeline_run(p);
    control_send(ctl_fd, "{\"type\":\"done\"}");
    return ret;
}

int main(int argc, char *argv[])
{
    EngineConfig cfg = ENGINE_CONFIG_DEFAULT;

    /* Phase 3: 交互模式选项 */
    bool interactive = false;
    int control_fd = 3;
    int fft_fd = -1;
    int fft_interval_ms = 100;

    static struct option long_opts[] = {
        {"bitrate",           required_argument, 0, 'b'},
        {"frame-size",        required_argument, 0, 'f'},
        {"sample-rate",       required_argument, 0, 'r'},
        {"channels",          required_argument, 0, 'c'},
        {"offset",            required_argument, 0, 'o'},
        {"eq",                required_argument, 0, 'e'},
        {"preamp",            required_argument, 0, 'p'},
        {"normalization",     no_argument,       0, 'n'},
        {"normalization-gain",required_argument, 0, 'g'},
        {"no-limiter",        no_argument,       0, 'L'},
        {"limiter-threshold", required_argument, 0, 'l'},
        {"fft",               no_argument,       0, 'F'},
        {"fft-size",          required_argument, 0, 's'},
        /* Phase 4 */
        {"tempo",             no_argument,       0, 'P'},
        {"tempo-speed",       required_argument, 0, 'Q'},
        {"tempo-pitch",       required_argument, 0, 'R'},
        {"tempo-pitch-sync",  no_argument,       0, 'S'},
        /* Phase 3 */
        {"interactive",       no_argument,       0, 'I'},
        {"control-fd",        required_argument, 0, 'C'},
        {"fft-fd",            required_argument, 0, 'D'},
        {"fft-interval-ms",   required_argument, 0, 'T'},
        /* 通用 */
        {"help",              no_argument,       0, 'h'},
        {"version",           no_argument,       0, 'v'},
        {0, 0, 0, 0},
    };

    int opt;
    while ((opt = getopt_long(argc, argv, "b:f:r:c:o:e:p:ng:Ll:s:FQ:R:PSIC:D:T:hv", long_opts, NULL)) != -1) {
        switch (opt) {
        case 'b': cfg.bitrate = atoi(optarg); break;
        case 'f': cfg.frame_size_ms = atoi(optarg); break;
        case 'r': cfg.output_sample_rate = atoi(optarg); break;
        case 'c': cfg.output_channels = atoi(optarg); break;
        case 'o': cfg.start_offset_ms = atol(optarg); break;
        case 'e': parse_eq_gains(optarg, cfg.eq_gains); break;
        case 'p': cfg.eq_preamp_db = atof(optarg); break;
        case 'n': cfg.normalization = true; break;
        case 'g': cfg.normalization_gain = atof(optarg); break;
        case 'L': cfg.limiter_enabled = false; break;
        case 'l': cfg.limiter_threshold_db = atof(optarg); break;
        case 'F': cfg.fft_enabled = true; break;
        case 's': cfg.fft_size = atoi(optarg); break;
        /* Phase 4 */
        case 'P': cfg.tempo_enabled = true; break;
        case 'Q': cfg.tempo_speed = atof(optarg); break;
        case 'R': cfg.tempo_pitch = atof(optarg); break;
        case 'S': cfg.tempo_pitch_sync = true; break;
        /* Phase 3 */
        case 'I': interactive = true; break;
        case 'C': control_fd = atoi(optarg); break;
        case 'D': fft_fd = atoi(optarg); break;
        case 'T': fft_interval_ms = atoi(optarg); break;
        /* 通用 */
        case 'h': print_usage(argv[0]); return 0;
        case 'v': fprintf(stderr, "%s\n", audio_engine_version()); return 0;
        default:  print_usage(argv[0]); return 1;
        }
    }

    if (optind >= argc) {
        fprintf(stderr, "错误：缺少输入文件\n\n");
        print_usage(argv[0]);
        return 1;
    }

    const char *source = argv[optind];

    /* 安装 SIGTERM 处理器：TS 层发送 kill 时优雅关闭，而非被终止 */
    struct sigaction sa;
    memset(&sa, 0, sizeof(sa));
    sa.sa_handler = handle_sigterm;
    sigaction(SIGTERM, &sa, NULL);

    /* 非交互模式关闭 stdin（stdin pipe 对 TS 层无用，提前释放 fd） */
    if (!interactive) {
        close(STDIN_FILENO);
    }

    /* 强制 Opus 使用 48000Hz */
    if (cfg.output_sample_rate != 48000) {
        fprintf(stderr, "[audio-engine] 警告：Opus 固定使用 48000Hz，已自动调整\n");
        cfg.output_sample_rate = 48000;
    }

    fprintf(stderr, "[audio-engine] 开始转码: %s\n", source);
    fprintf(stderr, "[audio-engine] 输出: %dHz / %dch / %dbps / %dms",
            cfg.output_sample_rate, cfg.output_channels,
            cfg.bitrate, cfg.frame_size_ms);
    if (cfg.start_offset_ms > 0) {
        fprintf(stderr, " / offset=%ldms", (long)cfg.start_offset_ms);
    }
    if (interactive) fprintf(stderr, " / interactive(ctl_fd=%d)", control_fd);
    fprintf(stderr, "\n");

    /* 打印 Phase 2 处理状态 */
    bool has_eq = false;
    for (int i = 0; i < EQ_BANDS; i++) {
        if (cfg.eq_gains[i] != 0.0f) { has_eq = true; break; }
    }
    if (has_eq || cfg.eq_preamp_db != 0.0f) {
        fprintf(stderr, "[audio-engine] EQ: preamp=%.1fdB, gains=[", cfg.eq_preamp_db);
        for (int i = 0; i < EQ_BANDS; i++)
            fprintf(stderr, "%.1f%s", cfg.eq_gains[i], i < 9 ? "," : "");
        fprintf(stderr, "]\n");
    }
    if (cfg.normalization) fprintf(stderr, "[audio-engine] 响度归一化: %.1fdB\n", cfg.normalization_gain);
    if (cfg.limiter_enabled) fprintf(stderr, "[audio-engine] 限幅器: %.1fdB\n", cfg.limiter_threshold_db);
    if (cfg.fft_enabled) fprintf(stderr, "[audio-engine] FFT: %d 点\n", cfg.fft_size);

    AudioPipeline *p = pipeline_create(source, &cfg, write_to_stdout, NULL);
    if (!p) {
        fprintf(stderr, "[audio-engine] 管线创建失败\n");
        return 2;
    }

    /* 注册全局指针，供 SIGTERM 处理器访问 */
    g_pipeline = p;

    fprintf(stderr, "[audio-engine] 源: %dHz / %dch / 时长 %.1fs\n",
            pipeline_get_source_sample_rate(p),
            pipeline_get_source_channels(p),
            pipeline_get_duration(p));

    int ret;
    if (interactive) {
        ret = run_interactive(p, control_fd, fft_fd, fft_interval_ms);
    } else {
        /* 批量模式：阻塞处理 */
        ret = pipeline_run(p);
    }

    if (ret < 0) {
        fprintf(stderr, "[audio-engine] 转码错误: %d\n", ret);
        pipeline_destroy(p);
        return 3;
    }

    fprintf(stderr, "[audio-engine] 转码完成\n");
    pipeline_destroy(p);
    return 0;
}
