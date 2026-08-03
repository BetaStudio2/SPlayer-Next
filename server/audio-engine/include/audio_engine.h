/**
 * audio_engine.h — 服务端音频引擎公开 API
 *
 * Phase 2：decode → resample → equalizer → loudness → limiter → fft → encode
 *
 * 设计目标：
 *   - 输入：任意 FFmpeg 支持的音频文件/URL
 *   - 输出：48kHz 立体声 OGG/Opus 流（写入自定义 IO 回调）
 *   - 零网络依赖：仅链接系统 FFmpeg
 */
#ifndef AUDIO_ENGINE_H
#define AUDIO_ENGINE_H

#include <stddef.h>
#include <stdint.h>
#include <stdbool.h>
#include <sys/types.h> /* ssize_t */

#ifdef __cplusplus
extern "C" {
#endif

#define EQ_BANDS 10

/** 引擎配置 */
typedef struct {
    int output_sample_rate;  /**< 输出采样率（Opus 固定 48000） */
    int output_channels;     /**< 输出声道数（通常 2） */
    int bitrate;             /**< Opus 比特率（bps，如 128000） */
    int frame_size_ms;       /**< Opus 帧时长（毫秒，通常 20） */
    int64_t start_offset_ms; /**< 跳过开头的毫秒数（CUE 分轨），0 从开头 */

    /* Phase 2: 音频处理 */
    float eq_gains[EQ_BANDS]; /**< 10 段 EQ 增益（dB），-12 ~ +12 */
    float eq_preamp_db;       /**< 前级增益（dB），-12 ~ +12 */
    bool  normalization;      /**< 响度归一化开关 */
    float normalization_gain; /**< 预计算响度增益（dB），0 = 不补偿 */
    bool  limiter_enabled;    /**< 限幅器开关 */
    float limiter_threshold_db; /**< 限幅器阈值（dB），默认 -1.0 */
    bool  fft_enabled;        /**< FFT 频谱分析开关 */
    int   fft_size;           /**< FFT 点数（如 1024, 2048） */

    /* Phase 4: 变速变调 */
    bool  tempo_enabled;      /**< 变速变调开关 */
    float tempo_speed;        /**< 播放速度 [0.5, 2.0], 默认 1.0 */
    float tempo_pitch;        /**< 音调偏移（半音）[-12, 12], 默认 0 */
    bool  tempo_pitch_sync;   /**< 保音调模式，默认 true */
} EngineConfig;

/** 默认配置宏 */
#define ENGINE_CONFIG_DEFAULT ((EngineConfig){ \
    .output_sample_rate = 48000, \
    .output_channels = 2, \
    .bitrate = 128000, \
    .frame_size_ms = 20, \
    .start_offset_ms = 0, \
    .eq_gains = {0}, \
    .eq_preamp_db = 0.0f, \
    .normalization = false, \
    .normalization_gain = 0.0f, \
    .limiter_enabled = true, \
    .limiter_threshold_db = -1.0f, \
    .fft_enabled = false, \
    .fft_size = 1024, \
    .tempo_enabled = false, \
    .tempo_speed = 1.0f, \
    .tempo_pitch = 0.0f, \
    .tempo_pitch_sync = true, \
})

/** 管线实例（不透明指针） */
typedef struct AudioPipeline AudioPipeline;

/** 输出回调：写入封装后的 OGG 字节流 */
typedef int (*OutputCallback)(const uint8_t *data, size_t size, void *user_data);

/**
 * 创建管线实例
 *
 * @param source  输入源（文件路径或 URL）
 * @param cfg     引擎配置
 * @param output  输出回调（封装后的 OGG 数据写入此处）
 * @param user    传给 output 的 user_data
 * @return 管线实例指针，失败返回 NULL
 */
AudioPipeline* pipeline_create(const char *source,
                                const EngineConfig *cfg,
                                OutputCallback output,
                                void *user);

/**
 * 驱动管线：解码 → 重采样 → EQ → 响度 → 限幅 → FFT → 编码 → 封装 → 输出
 *
 * 每次调用处理若干帧，通过 output 回调写出数据。
 * 当返回值为 0 时表示输入已读完且编码器已 flush。
 *
 * @return >0 表示本次处理的帧数，0 表示 EOF，<0 表示错误
 */
ssize_t pipeline_process(AudioPipeline *p);

/** 一次性处理完整个输入（阻塞直到 EOF） */
int pipeline_run(AudioPipeline *p);

/** 获取源文件时长（秒） */
double pipeline_get_duration(const AudioPipeline *p);

/** 获取源文件采样率 */
int pipeline_get_source_sample_rate(const AudioPipeline *p);

/** 获取源文件声道数 */
int pipeline_get_source_channels(const AudioPipeline *p);

/**
 * Phase 3: 运行时交互控制
 */

/** 获取当前播放位置（已处理的秒数） */
double pipeline_get_position(const AudioPipeline *p);

/** 运行时设置 EQ 增益（10 段，dB） */
void pipeline_set_eq_gains(AudioPipeline *p, const float gains[EQ_BANDS]);

/** 运行时设置前级增益（dB） */
void pipeline_set_preamp(AudioPipeline *p, float preamp_db);

/** 运行时设置音量增益（0~1.5，1.0 为原音量） */
void pipeline_set_volume(AudioPipeline *p, float volume);

/** 运行时启用/禁用响度归一化 */
void pipeline_set_normalization_enabled(AudioPipeline *p, bool enabled);

/** 运行时启用/禁用限幅器 */
void pipeline_set_limiter_enabled(AudioPipeline *p, bool enabled);

/** 运行时启用/禁用 FFT */
void pipeline_set_fft_enabled(AudioPipeline *p, bool enabled);

/** 获取 FFT 频谱数据（dB 值，输出到 out_db 缓冲区） */
int pipeline_get_fft_spectrum(AudioPipeline *p, float *out_db, int bins, float min_db);

/**
 * 获取立体声 FFT 频谱数据（dB，左右声道独立）
 *
 * @param p         管线实例
 * @param out_db_l  输出左声道 dB 值缓冲区
 * @param out_db_r  输出右声道 dB 值缓冲区
 * @param bins      频段数
 * @param min_db    最小 dB 值
 * @return 0 成功，-1 参数错误
 */
int pipeline_get_fft_spectrum_stereo(AudioPipeline *p,
                                     float *out_db_l, float *out_db_r,
                                     int bins, float min_db);

/** 获取 FFT 点数 */
int pipeline_get_fft_size(const AudioPipeline *p);

/**
 * Phase 4: 变速变调
 */

/** 运行时设置播放速度 */
void pipeline_set_tempo_speed(AudioPipeline *p, float speed);

/** 运行时设置音调偏移（半音） */
void pipeline_set_tempo_pitch(AudioPipeline *p, float semitones);

/** 运行时切换保音调模式 */
void pipeline_set_tempo_pitch_sync(AudioPipeline *p, bool sync);

/** 运行时启用/禁用变速变调 */
void pipeline_set_tempo_enabled(AudioPipeline *p, bool enabled);

/** 销毁管线并释放资源 */
void pipeline_destroy(AudioPipeline *p);

/** 获取引擎版本字符串 */
const char* audio_engine_version(void);

/**
 * 请求管线优雅关闭（SIGTERM 信号处理器调用）
 * 设置内部 EOF 标志，正在运行的 pipeline_process/pipeline_run 将在框架边界处退出
 */
void pipeline_signal_shutdown(AudioPipeline *p);

#ifdef __cplusplus
}
#endif

#endif /* AUDIO_ENGINE_H */
