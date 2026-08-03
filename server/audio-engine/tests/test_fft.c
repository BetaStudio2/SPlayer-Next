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

    /* ── 5.1 多声道自适应测试 ─────────────────────────────────── */
    FFTAnalyzer *fft51 = fft_create(48000, 1024);
    assert(fft51 != NULL);
    fft_set_enabled(fft51, true);

    /* 中央声道 440Hz（6ch 交错：FL FR C LFE BL BR），左右下混应一致 */
    float pcm51[1024 * 6];
    for (int i = 0; i < 1024; i++) {
        float v = sinf(2.0f * M_PI * 440.0f * i / 48000.0f);
        pcm51[i * 6 + 0] = 0.0f; /* FL */
        pcm51[i * 6 + 1] = 0.0f; /* FR */
        pcm51[i * 6 + 2] = v;    /* C */
        pcm51[i * 6 + 3] = 0.0f; /* LFE */
        pcm51[i * 6 + 4] = 0.0f; /* BL */
        pcm51[i * 6 + 5] = 0.0f; /* BR */
    }
    fft_process_multi(fft51, pcm51, 1024, 6);

    float db51_l[128], db51_r[128];
    fft_get_spectrum_db_stereo(fft51, db51_l, db51_r, 128, -120.0f);
    int active51_l = 0, active51_r = 0;
    for (int i = 0; i < 128; i++) {
        if (db51_l[i] > -120.0f) active51_l++;
        if (db51_r[i] > -120.0f) active51_r++;
    }
    assert(active51_l > 0 && active51_r > 0);
    for (int i = 0; i < 128; i++) {
        assert(fabsf(db51_l[i] - db51_r[i]) < 0.1f);
    }

    /* 仅左声道（FL）有信号时，右声道频谱应为静音 */
    for (int i = 0; i < 1024; i++) {
        float v = sinf(2.0f * M_PI * 440.0f * i / 48000.0f);
        pcm51[i * 6 + 0] = v;
        pcm51[i * 6 + 1] = 0.0f;
        pcm51[i * 6 + 2] = 0.0f;
        pcm51[i * 6 + 3] = 0.0f;
        pcm51[i * 6 + 4] = 0.0f;
        pcm51[i * 6 + 5] = 0.0f;
    }
    fft_process_multi(fft51, pcm51, 1024, 6);
    memset(db51_l, 0, sizeof(db51_l));
    memset(db51_r, 0, sizeof(db51_r));
    fft_get_spectrum_db_stereo(fft51, db51_l, db51_r, 128, -120.0f);
    active51_l = 0;
    active51_r = 0;
    for (int i = 0; i < 128; i++) {
        if (db51_l[i] > -120.0f) active51_l++;
        if (db51_r[i] > -120.0f) active51_r++;
    }
    assert(active51_l > 0 && active51_r == 0);
    fft_destroy(fft51);

    /* ── 单声道自适应：左右频谱应一致 ─────────────────────────── */
    FFTAnalyzer *fftMono = fft_create(48000, 1024);
    assert(fftMono != NULL);
    fft_set_enabled(fftMono, true);
    fft_process_multi(fftMono, sine, 1024, 1);
    float dbM_l[128], dbM_r[128];
    fft_get_spectrum_db_stereo(fftMono, dbM_l, dbM_r, 128, -120.0f);
    for (int i = 0; i < 128; i++) {
        assert(fabsf(dbM_l[i] - dbM_r[i]) < 0.1f);
    }
    fft_destroy(fftMono);

    return 0;
}
