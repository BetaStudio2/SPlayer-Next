/**
 * decoder.h — FFmpeg 音频解码器
 *
 * 打开任意 FFmpeg 支持的音频源，解码为 PCM AVFrame。
 */
#ifndef DECODER_H
#define DECODER_H

#include <libavformat/avformat.h>
#include <libavcodec/avcodec.h>
#include <stdbool.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef struct Decoder Decoder;

/** 创建解码器，打开指定源 */
Decoder* decoder_open(const char *url);

/**
 * 读取下一帧解码后的 PCM
 *
 * @param frame  调用者提供的 AVFrame*（由 decoder 内部填充）
 * @return 1 成功，0 EOF，<0 错误
 */
int decoder_read_frame(Decoder *d, AVFrame **frame);

/**
 * 跳转到指定毫秒位置
 *
 * 跳转到输入文件中距离 offset_ms 最近的干净关键帧，
 * 后续 decoder_read_frame 将从该位置开始输出。
 *
 * @return 0 成功，<0 错误
 */
int decoder_seek_ms(Decoder *d, int64_t offset_ms);

/** 获取源音频流参数 */
int decoder_sample_rate(const Decoder *d);
int decoder_channels(const Decoder *d);
int64_t decoder_duration_us(const Decoder *d);
const char* decoder_codec_name(const Decoder *d);

/** 关闭并释放 */
void decoder_close(Decoder *d);

#ifdef __cplusplus
}
#endif

#endif /* DECODER_H */
