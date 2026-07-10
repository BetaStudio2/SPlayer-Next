/**
 * test_fft.c — FFT 频谱分析单元测试
 */
#include "../src/fft.h"
#include <assert.h>
#include <math.h>
#include <string.h>

#ifndef M_PI
#define M_PI 3.14159265358979323846
#endif

int main(void) {
    FFTAnalyzer *fft = fft_create(48000, 1024);
    assert(fft != NULL);

    assert(fft_get_size(fft) == 1024);
    assert(fft_get_sample_rate(fft) == 48000);

    /* 默认禁用，频谱输出应为 min_db 截断值 */
    float db[128];
    memset(db, 0, sizeof(db));
    fft_get_spectrum_db(fft, db, 128, -60.0f);
    /* 禁用时输出应为全 min_db（-60.0f） */
    int non_min = 0;
    for (int i = 0; i < 128; i++) {
        if (fabsf(db[i] - (-60.0f)) > 0.1f) non_min++;
    }
    assert(non_min == 0);

    /* 启用并送入正弦波 */
    fft_set_enabled(fft, true);

    /* 440Hz 正弦波 */
    float sine[1024];
    for (int i = 0; i < 1024; i++) {
        sine[i] = sinf(2.0f * M_PI * 440.0f * i / 48000.0f);
    }
    fft_process(fft, sine, 1024);

    /* 频谱应有输出 */
    memset(db, 0, sizeof(db));
    fft_get_spectrum_db(fft, db, 128, -120.0f);

    /* 至少有一些非零输出 */
    int active_bins = 0;
    for (int i = 0; i < 128; i++) {
        if (db[i] > -120.0f) active_bins++;
    }
    assert(active_bins > 0);

    /* 峰值谱 */
    float peak[128];
    memset(peak, 0, sizeof(peak));
    fft_get_peak_spectrum(fft, peak, 128);
    /* 第一次调用后峰值应有值 */
    int peak_bins = 0;
    for (int i = 0; i < 128; i++) {
        if (peak[i] > 0.0f) peak_bins++;
    }
    assert(peak_bins > 0);

    /* 重置峰值 */
    fft_reset_peak(fft);
    memset(peak, 0, sizeof(peak));
    fft_get_peak_spectrum(fft, peak, 128);
    int reset_bins = 0;
    for (int i = 0; i < 128; i++) {
        if (peak[i] > 0.0f) reset_bins++;
    }
    assert(reset_bins == 0);

    fft_destroy(fft);
    return 0;
}
