# 原生模块第三方许可证声明（native / Rust）

本目录 `native` 为 SPlayer-Next 桌面程序的 Rust 原生模块
（audio-engine / media-ctrl / taskbar-lyric / taskbar-thumbnail / download-engine），
随本软件以 AGPL-3.0 授权。

## 各模块共同/主要依赖许可证

| 组件 | 许可证 | 说明 |
|---|---|---|
| `napi` / `napi-derive` | MIT | Node-API 绑定 |
| `ffmpeg_audio`（audio-engine） | LGPL（静态链接 FFmpeg，纯 LGPL 构建） | 音视频解码，见下 |
| `rodio` / `cpal` | MIT / Apache-2.0 | 音频播放与后端 |
| `lofty` | MIT / Apache-2.0 | 标签读写 |
| `image` / `rustfft` / `signalsmith-stretch` | MIT / Apache-2.0 | 图像 / FFT / 伸缩 |
| `ureq` | MIT | HTTP 客户端 |
| `tokio` / `anyhow` / `thiserror` / `serde` / `tracing*` / `time` / `walkdir` / `parking_lot` / `libc` | MIT / Apache-2.0 | 基础设施 |
| `windows` / `windows-core` / `winreg`（Win） | MIT / Apache-2.0 | Windows API 绑定 |
| `objc2` 系列（macOS） | MIT / Apache-2.0 | macOS API 绑定 |
| `mpris-server`（Linux, media-ctrl） | MIT | MPRIS 实现 |
| `discord-rich-presence`（media-ctrl） | MIT | Discord RPC |
| `reqwest` / `futures` / `clap`（download-engine） | MIT / Apache-2.0 | 下载引擎 |

## audio-engine：FFmpeg 静态链接声明（LGPL）

`native/audio-engine` 通过 `ffmpeg_audio` 将 **FFmpeg** 以**静态库形式编译并链接**。
经构建配置确认（`config.h` 中 `CONFIG_GPL=0`、`CONFIG_NONFREE=0`），
所用 FFmpeg 为**纯 LGPL 构建**，未启用任何 GPL/nonfree 外部编解码库。

依据 LGPL-2.1 第 6 条（静态链接），该 `.node` 模块被视为对 FFmpeg 库的修改作品，
使用者有权：(a) 获得 FFmpeg 对应源代码；(b) 以修改后的 FFmpeg 重新链接/替换该模块中
FFmpeg 部分。FFmpeg 对应源代码与构建配置见 https://github.com/SPlayer-Dev/ffmpeg-audio。

## 许可兼容性结论

所有原生模块依赖均为 MIT / Apache-2.0 / LGPL（FFmpeg，弱拷贝左），
与本项目 AGPL-3.0 兼容，无 GPL 传染冲突。
原生模块整体作为 AGPL-3.0 受保护作品的一部分分发，合规。

---
AGPL-3.0 完整文本见仓库根 `LICENSE`；第三方声明总览见根 `THIRD-PARTY-NOTICES.md`。
