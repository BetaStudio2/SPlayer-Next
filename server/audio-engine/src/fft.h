/**
 * fft.h — 频谱分析（用于前端可视化）
 *
 * 自实现 Cooley-Tukey 基 2 FFT，无外部依赖。
 * 支持：
 *   - 任意 2 的幂次 FFT 点数
 *   - Hann 窗函数
 *   - 频谱平滑（指数移动平均）
 *   - 对数刻度（dB）
 *   - 频段聚合（任意输出频段数）
 *   - 峰值保持 + 衰减
 */
#ifndef FFT_H
#define FFT_H

#include <stdbool.h>

typedef struct FFTAnalyzer FFTAnalyzer;

/**
 * 创建 FFT 分析器实例
 *
 * @param sample_rate  采样率（Hz）
 * @param fft_size     FFT 点数（必须是 2 的幂，如 1024, 2048, 4096）
 * @return 实例，失败返回 NULL
 */
FFTAnalyzer* fft_create(int sample_rate, int fft_size);

/**
 * 启用/禁用 FFT 分析
 *
 * @param fft     实例
 * @param enabled 是否启用
 */
void fft_set_enabled(FFTAnalyzer *fft, bool enabled);

/**
 * 处理 PCM 数据（提取频谱）
 *
 * @param fft     实例
 * @param pcm     交错 float PCM 数据（仅使用第一声道）
 * @param samples 样本数（每声道）
 */
void fft_process(FFTAnalyzer *fft, const float *pcm, int samples);

/**
 * 获取线性幅度谱
 *
 * @param fft       实例
 * @param out_mag   输出幅度谱（线性，0~1），至少 bins 个元素
 * @param bins      请求的频段数
 */
void fft_get_spectrum(const FFTAnalyzer *fft, float *out_mag, int bins);

/**
 * 获取对数频谱（dB）
 *
 * @param fft       实例
 * @param out_db    输出 dB 值（通常 -60~0），至少 bins 个元素
 * @param bins      请求的频段数
 * @param min_db    最小 dB 值（低于此值截断），如 -60.0f
 */
void fft_get_spectrum_db(const FFTAnalyzer *fft, float *out_db, int bins, float min_db);

/**
 * 获取峰值保持谱
 *
 * @param fft       实例
 * @param out_peak  输出峰值谱（线性，0~1），至少 bins 个元素
 * @param bins      请求的频段数
 */
void fft_get_peak_spectrum(const FFTAnalyzer *fft, float *out_peak, int bins);

/**
 * 重置峰值保持
 */
void fft_reset_peak(FFTAnalyzer *fft);

/**
 * 设置平滑系数
 *
 * @param fft       实例
 * @param alpha     平滑系数（0~1），越大越平滑，0.8 为常用值
 */
void fft_set_smoothing(FFTAnalyzer *fft, float alpha);

/**
 * 设置峰值衰减速度
 *
 * @param fft       实例
 * @param decay     每帧衰减量（0~1），如 0.01f
 */
void fft_set_peak_decay(FFTAnalyzer *fft, float decay);

/**
 * 获取 FFT 点数
 */
int fft_get_size(const FFTAnalyzer *fft);

/**
 * 获取采样率
 */
int fft_get_sample_rate(const FFTAnalyzer *fft);

/** 销毁实例 */
void fft_destroy(FFTAnalyzer *fft);

#endif /* FFT_H */
