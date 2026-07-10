/**
 * fft.c — 频谱分析
 *
 * 自实现 Cooley-Tukey 基 2 FFT，无外部依赖。
 * 功能：
 *   - O(n log n) 快速傅里叶变换
 *   - Hann 窗函数
 *   - 频谱平滑（指数移动平均）
 *   - 对数刻度（dB）转换
 *   - 频段聚合（任意输出频段数）
 *   - 峰值保持 + 衰减
 */
#include "fft.h"
#include <stdlib.h>
#include <string.h>
#include <math.h>

#define LOG_TAG "[audio-engine:fft]"
#include <stdio.h>

#ifndef M_PI
#define M_PI 3.14159265358979323846
#endif

/* 默认参数 */
#define DEFAULT_SMOOTHING 0.0f    /* 无平滑 */
#define DEFAULT_PEAK_DECAY 0.01f  /* 每帧衰减 1% */
#define MIN_DB -120.0f            /* dB 下限 */

struct FFTAnalyzer {
    int sample_rate;
    int fft_size;
    int fft_order;          /* log2(fft_size) */
    bool enabled;

    /* 窗函数 */
    float *window;

    /* 输入缓冲 */
    float *input_buf;
    int buf_pos;

    /* FFT 工作区 */
    float *fft_real;
    float *fft_imag;

    /* 频谱数据 */
    float *spectrum;        /* 线性幅度谱（平滑后） */
    float *raw_spectrum;    /* 原始频谱（未平滑） */
    float *peak_spectrum;   /* 峰值保持谱 */

    /* 参数 */
    float smoothing;        /* 平滑系数 0~1 */
    float peak_decay;       /* 峰值衰减速度 */
};

/* ─── 工具函数 ─────────────────────────────────────────────── */

/* 检查是否为 2 的幂 */
static bool is_power_of_two(int n)
{
    return n > 0 && (n & (n - 1)) == 0;
}

/* 计算 log2(n) */
static int log2_int(int n)
{
    int order = 0;
    while (n > 1) {
        n >>= 1;
        order++;
    }
    return order;
}

/* ─── Cooley-Tukey 基 2 FFT ────────────────────────────────── */

/*
 * 原地计算 FFT（迭代版本，避免递归）
 * 输入：fft_real, fft_imag（长度 fft_size）
 * 输出：fft_real, fft_imag（频域数据）
 */
static void compute_fft_inplace(float *real, float *imag, int size, int order)
{
    /* 位反转置换 */
    for (int i = 0; i < size; i++) {
        int j = 0;
        for (int k = 0; k < order; k++) {
            j = (j << 1) | ((i >> k) & 1);
        }
        if (j > i) {
            float tmp = real[i];
            real[i] = real[j];
            real[j] = tmp;
            tmp = imag[i];
            imag[i] = imag[j];
            imag[j] = tmp;
        }
    }

    /* 蝶形运算 */
    for (int stage = 1; stage <= order; stage++) {
        int m = 1 << stage;           /* 子问题大小 */
        int half_m = m >> 1;
        float angle = -2.0f * M_PI / m;
        float w_real = cosf(angle);
        float w_imag = sinf(angle);

        for (int k = 0; k < size; k += m) {
            float wr = 1.0f;
            float wi = 0.0f;

            for (int j = 0; j < half_m; j++) {
                int idx1 = k + j;
                int idx2 = k + j + half_m;

                /* 蝶形运算 */
                float tr = wr * real[idx2] - wi * imag[idx2];
                float ti = wr * imag[idx2] + wi * real[idx2];

                real[idx2] = real[idx1] - tr;
                imag[idx2] = imag[idx1] - ti;
                real[idx1] += tr;
                imag[idx1] += ti;

                /* 旋转因子更新 */
                float new_wr = wr * w_real - wi * w_imag;
                float new_wi = wr * w_imag + wi * w_real;
                wr = new_wr;
                wi = new_wi;
            }
        }
    }
}

/* ─── 频谱处理 ─────────────────────────────────────────────── */

/* 计算幅度谱（归一化到 0~1） */
static void compute_magnitude(const float *real, const float *imag,
                              float *out, int size)
{
    int half = size / 2;
    float scale = 2.0f / size;  /* 归一化因子 */

    for (int i = 0; i < half; i++) {
        float r = real[i];
        float im = imag[i];
        out[i] = sqrtf(r * r + im * im) * scale;
    }
}

/* 指数移动平均平滑 */
static void apply_smoothing(float *spectrum, const float *raw,
                            int size, float alpha)
{
    if (alpha <= 0.0f) {
        memcpy(spectrum, raw, size * sizeof(float));
    } else {
        for (int i = 0; i < size; i++) {
            spectrum[i] = alpha * spectrum[i] + (1.0f - alpha) * raw[i];
        }
    }
}

/* 峰值保持 + 衰减 */
static void update_peak(float *peak, const float *spectrum,
                        int size, float decay)
{
    for (int i = 0; i < size; i++) {
        if (spectrum[i] > peak[i]) {
            peak[i] = spectrum[i];
        } else {
            peak[i] -= decay;
            if (peak[i] < 0.0f) peak[i] = 0.0f;
        }
    }
}

/* ─── 公共 API ─────────────────────────────────────────────── */

FFTAnalyzer* fft_create(int sample_rate, int fft_size)
{
    if (!is_power_of_two(fft_size)) {
        fprintf(stderr, "%s 错误: fft_size 必须是 2 的幂，收到 %d\n",
                LOG_TAG, fft_size);
        return NULL;
    }

    FFTAnalyzer *fft = calloc(1, sizeof(*fft));
    if (!fft) return NULL;

    fft->sample_rate = sample_rate;
    fft->fft_size = fft_size;
    fft->fft_order = log2_int(fft_size);
    fft->enabled = false;
    fft->smoothing = DEFAULT_SMOOTHING;
    fft->peak_decay = DEFAULT_PEAK_DECAY;

    int half = fft_size / 2;

    /* 分配内存 */
    fft->window = malloc(fft_size * sizeof(float));
    fft->input_buf = malloc(fft_size * sizeof(float));
    fft->fft_real = malloc(fft_size * sizeof(float));
    fft->fft_imag = malloc(fft_size * sizeof(float));
    fft->spectrum = malloc(half * sizeof(float));
    fft->raw_spectrum = malloc(half * sizeof(float));
    fft->peak_spectrum = malloc(half * sizeof(float));

    if (!fft->window || !fft->input_buf || !fft->fft_real ||
        !fft->fft_imag || !fft->spectrum || !fft->raw_spectrum ||
        !fft->peak_spectrum) {
        fft_destroy(fft);
        return NULL;
    }

    /* 初始化 Hann 窗 */
    for (int i = 0; i < fft_size; i++) {
        fft->window[i] = 0.5f * (1.0f - cosf(2.0f * M_PI * i / (fft_size - 1)));
    }

    /* 初始化峰值谱 */
    memset(fft->peak_spectrum, 0, half * sizeof(float));

    fprintf(stderr, "%s 创建: %dHz / FFT %d 点 (order=%d)\n",
            LOG_TAG, sample_rate, fft_size, fft->fft_order);
    return fft;
}

void fft_set_enabled(FFTAnalyzer *fft, bool enabled)
{
    if (!fft) return;
    fft->enabled = enabled;
}

void fft_set_smoothing(FFTAnalyzer *fft, float alpha)
{
    if (!fft) return;
    if (alpha < 0.0f) alpha = 0.0f;
    if (alpha > 0.99f) alpha = 0.99f;
    fft->smoothing = alpha;
}

void fft_set_peak_decay(FFTAnalyzer *fft, float decay)
{
    if (!fft) return;
    if (decay < 0.0f) decay = 0.0f;
    if (decay > 1.0f) decay = 1.0f;
    fft->peak_decay = decay;
}

void fft_reset_peak(FFTAnalyzer *fft)
{
    if (!fft) return;
    memset(fft->peak_spectrum, 0, (fft->fft_size / 2) * sizeof(float));
}

int fft_get_size(const FFTAnalyzer *fft)
{
    return fft ? fft->fft_size : 0;
}

int fft_get_sample_rate(const FFTAnalyzer *fft)
{
    return fft ? fft->sample_rate : 0;
}

void fft_process(FFTAnalyzer *fft, const float *pcm, int samples)
{
    if (!fft || !pcm || samples <= 0) return;
    if (!fft->enabled) return;

    int half = fft->fft_size / 2;

    /* 收集样本到缓冲（仅使用第一声道） */
    for (int i = 0; i < samples; i++) {
        if (fft->buf_pos < fft->fft_size) {
            fft->input_buf[fft->buf_pos++] = pcm[i * 2];  /* 左声道 */
        }

        /* 缓冲满时计算 FFT */
        if (fft->buf_pos >= fft->fft_size) {
            /* 应用窗函数 */
            for (int j = 0; j < fft->fft_size; j++) {
                fft->fft_real[j] = fft->input_buf[j] * fft->window[j];
                fft->fft_imag[j] = 0.0f;
            }

            /* 计算 FFT */
            compute_fft_inplace(fft->fft_real, fft->fft_imag,
                               fft->fft_size, fft->fft_order);

            /* 计算幅度谱 */
            compute_magnitude(fft->fft_real, fft->fft_imag,
                            fft->raw_spectrum, fft->fft_size);

            /* 平滑 */
            apply_smoothing(fft->spectrum, fft->raw_spectrum,
                          half, fft->smoothing);

            /* 更新峰值 */
            update_peak(fft->peak_spectrum, fft->spectrum,
                       half, fft->peak_decay);

            /* 清空缓冲，保留一半重叠 */
            int overlap = half;
            memmove(fft->input_buf, fft->input_buf + overlap,
                   overlap * sizeof(float));
            fft->buf_pos = overlap;
        }
    }
}

void fft_get_spectrum(const FFTAnalyzer *fft, float *out_mag, int bins)
{
    if (!fft || !out_mag || bins <= 0) return;

    int half = fft->fft_size / 2;
    if (bins > half) bins = half;

    /* 线性插值聚合到目标频段数 */
    if (bins == half) {
        memcpy(out_mag, fft->spectrum, half * sizeof(float));
    } else {
        float step = (float)half / bins;
        for (int i = 0; i < bins; i++) {
            float pos = i * step;
            int idx = (int)pos;
            float frac = pos - idx;

            if (idx + 1 < half) {
                out_mag[i] = fft->spectrum[idx] * (1.0f - frac) +
                            fft->spectrum[idx + 1] * frac;
            } else {
                out_mag[i] = fft->spectrum[idx];
            }
        }
    }
}

void fft_get_spectrum_db(const FFTAnalyzer *fft, float *out_db,
                         int bins, float min_db)
{
    if (!fft || !out_db || bins <= 0) return;

    int half = fft->fft_size / 2;
    if (bins > half) bins = half;

    /* 先获取线性谱 */
    float *linear = malloc(half * sizeof(float));
    if (!linear) return;

    fft_get_spectrum(fft, linear, bins);

    /* 转换为 dB */
    for (int i = 0; i < bins; i++) {
        float mag = linear[i];
        if (mag < 1e-10f) mag = 1e-10f;  /* 避免 log(0) */
        float db = 20.0f * log10f(mag);
        if (db < min_db) db = min_db;
        out_db[i] = db;
    }

    free(linear);
}

void fft_get_peak_spectrum(const FFTAnalyzer *fft, float *out_peak, int bins)
{
    if (!fft || !out_peak || bins <= 0) return;

    int half = fft->fft_size / 2;
    if (bins > half) bins = half;

    /* 线性插值聚合到目标频段数 */
    if (bins == half) {
        memcpy(out_peak, fft->peak_spectrum, half * sizeof(float));
    } else {
        float step = (float)half / bins;
        for (int i = 0; i < bins; i++) {
            float pos = i * step;
            int idx = (int)pos;
            float frac = pos - idx;

            if (idx + 1 < half) {
                out_peak[i] = fft->peak_spectrum[idx] * (1.0f - frac) +
                             fft->peak_spectrum[idx + 1] * frac;
            } else {
                out_peak[i] = fft->peak_spectrum[idx];
            }
        }
    }
}

void fft_destroy(FFTAnalyzer *fft)
{
    if (!fft) return;
    free(fft->window);
    free(fft->input_buf);
    free(fft->fft_real);
    free(fft->fft_imag);
    free(fft->spectrum);
    free(fft->raw_spectrum);
    free(fft->peak_spectrum);
    free(fft);
}
