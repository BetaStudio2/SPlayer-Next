# 服务端音频引擎（audio-engine-server）

## 动机

### 当前架构问题

```
Web 端 （不解码状态）             服务端
┌─────────────────────┐       ┌─────────────────────┐
│ <audio>              │  HTTP │  /api/music/stream  │
│  原生浏览器解码      │←─────→│  原始文件流式传输    │
│  手写 Biquad EQ     │       │                     │
│  手写 Loudness      │       │  subsonic-transcoder│
│  AnalyserNode       │       │  (symphonia解码)    │
│  全部 JS 处理       │       │                     │
└─────────────────────┘       └─────────────────────┘
```

1. **性能瓶颈**：EQ、响度归一化、FFT 全部在浏览器 JS 主线程处理，高采样率下 CPU 开销大
2. **响度归一化受限**：浏览器 `AudioWorklet` 实现 EBU R128 能力有限，延迟不稳定
3. **上游变更风险**：`htmlAudioElement` + `AudioContext` API 依赖浏览器实现，上游（桌面端 `audio-engine`）做破坏性修改后，Web 端 `WebAudioPlayer` 需要独立维护一套等效逻辑
4. **构建网络依赖**：桌面端 `audio-engine` 构建需下载 FFmpeg 静态库；服务端可改用**系统 FFmpeg** 消除此问题

### 方案：服务端音频处理 → 推流给浏览器

```
Web 端                             服务端
┌─────────────────────┐           ┌────────────────────────────┐
│ <audio>              │  Opus流  │  audio-engine-server        │
│  简单播放接收端      │←─────────→│                            │
│  零处理逻辑          │           │  ┌─ FFmpeg 解码 ────────┐  │
│                     │           │  │  → swresample 重采样  │  │
│  （可选 Worklet     │           │  │  → Opus 编码+OGG封装  │  │
│    PCM播放）        │           │  └──────────────────────┘  │
└─────────────────────┘           └────────────────────────────┘
```

- 浏览器只需要做一件事：**播放服务端推送的已处理音频流**
- 解码、EQ、响度归一化、FFT 等全部在服务端 C 代码中完成
- Web 端 `WebAudioPlayer` 可大幅简化

### 渐进式迁移路径

```
checkAudioEngineStatus()
├─ true  (引擎可用)  → /api/audio/stream/:id?bitrate=128  服务端解码→转码Opus
│                      浏览器 <audio> 原生播放 Opus 流
│
└─ false (引擎不可用) → /api/music/stream/:id              原始文件流（回退）
                          浏览器 <audio> 原生解码
                          + WebAudio EQ/loudness/FFT
```

引擎可用性由 `/api/audio/status` 端点检测，前端自动切换。引擎不可用时的回退路径就是当前的生产路径。

---

## 架构

### 整体结构

```
server/audio-engine/
├── CMakeLists.txt              # CMake 构建（含 Rust tempo 自动检测）
├── include/
│   └── audio_engine.h          # 公开 C API
├── src/
│   ├── decoder.c               # FFmpeg 解码（avformat + avcodec）
│   ├── decoder.h               #   含 decoder_seek_ms（CUE 分轨）
│   ├── resampler.c             # 重采样（swresample）
│   ├── resampler.h
│   ├── equalizer.c             # 10 段 Biquad IIR 均衡器
│   ├── equalizer.h
│   ├── loudness.c              # EBU R128 响度归一化（静态增益补偿）
│   ├── loudness.h
│   ├── limiter.c               # Soft-knee 输出限幅器
│   ├── limiter.h
│   ├── tempo.c                 # 变速变调（C FFI → Rust signalsmith-stretch）
│   ├── tempo.h                 #   含 HAS_TEMPO 条件编译（无 cargo 时 stub）
│   ├── fft.c                   # 频谱分析（Hann 窗 + DFT）
│   ├── fft.h
│   ├── encoder.c               # Opus 编码 + OGG 封装
│   ├── encoder.h
│   ├── pipeline.c              # 处理管线编排：decode → resample → eq → loudness → limiter → tempo → fft → encode
│   └── main.c                  # CLI 入口（含 --interactive 交互模式 + control-fd/fft-fd 协议）
├── tempo-rs/                   # Rust tempo 静态库
│   ├── Cargo.toml
│   └── src/
│       └── lib.rs              # signalsmith-stretch C FFI 封装
├── binding.ts                  # TypeScript 子进程封装（含 InteractiveAudioEngine 类）
└── tests/                      # 单元测试（equalizer / limiter / fft / loudness）
```

**已实现模块：**
- [x] `decoder.c` — FFmpeg 解码（任意格式） + `decoder_seek_ms()` CUE 分轨偏移
- [x] `resampler.c` — swresample 重采样到 48kHz
- [x] `equalizer.c` — 10 段 Biquad IIR 均衡器（31.25Hz~16kHz，Audio EQ Cookbook 公式）
- [x] `loudness.c` — EBU R128 响度归一化（预计算增益模式，避免实时延迟）
- [x] `limiter.c` — Soft-knee 限幅器（4:1 压缩比，默认 -1dB 阈值）
- [x] `tempo.c` — 变速变调（C FFI → Rust signalsmith-stretch，无 cargo 时 stub bypass）
- [x] `fft.c` — 频谱分析（Cooley-Tukey 基 2 FFT，Hann 窗，平滑，dB 转换，峰值保持，自适应 1~6 声道下混）
- [x] `encoder.c` — libopus 编码 + OGG 容器封装
- [x] `pipeline.c` — 完整管线：decode → resample → eq → loudness → limiter → tempo → fft → encode
- [x] `main.c` — CLI，支持 `--interactive` 交互模式 + `--control-fd` / `--fft-fd` 协议
- [x] `binding.ts` — TS 封装，含 `InteractiveAudioEngine` 类（Phase 3 交互控制）
- [x] `routes/audio.ts` — `GET /api/audio/stream/:id` + `/api/audio/status` + `POST /api/audio/control/:id`
- [x] `web/api/player.ts` — 前端引擎检测 + 自动切换转码路径 + QualityLevel→bitrate 映射
- [x] `routes/ws.ts` — WebSocket FFT 订阅/广播（`audio:subscribe` / `audio:unsubscribe`）

### 语言选择

| 模块 | 语言 | 原因 |
|------|------|------|
| decoder, resampler, equalizer, loudness, limiter, fft, encoder, pipeline | **C** | 链接系统 FFmpeg，零网络依赖构建 |
| 变速变调（tempo） | **Rust**（signalsmith-stretch） | 无纯 C 等效库；`SoundTouch` 是 C++，`rubberband` 也是 C++ 依赖 |

### 数据流

```
输入文件/URL
    │
    ▼
┌──────────────┐
│  decoder.c   │  FFmpeg avformat_open_input → avcodec_send/receive
│              │  输出：PCM float 平面格式
└──────┬───────┘
       │ PCM（原始采样率，原始格式）
       ▼
┌──────────────┐
│  resampler.c │  swresample → 48kHz float 交错
└──────┬───────┘
       │ PCM（48000Hz, float, 2ch）
       ▼
┌──────────────┐
│  equalizer.c │  10 段 Biquad IIR 均衡器
└──────┬───────┘
       │
       ▼
┌──────────────┐
│  loudness.c  │  EBU R128 响度归一化（静态增益补偿）
└──────┬───────┘
       │
       ▼
┌──────────────┐
│  limiter.c   │  Soft-knee 限幅器
└──────┬───────┘
       │
       ▼
┌──────────────┐
│  tempo.c     │  变速变调（Rust signalsmith-stretch）
│              │  样本数可能改变（speed ≠ 1.0）
└──────┬───────┘
       │
       ▼
┌──────────────┐
│  fft.c       │  频谱分析（Hann 窗 + DFT + 自适应 1~6 声道下混）
│              │  数据通过 fd 4 JSON 行协议推送
└──────┬───────┘
       │
       ▼
┌──────────────┐
│  encoder.c   │  libopus → OGG 容器封装
└──────┬───────┘
       │ OGG/Opus 字节流
       ▼
  stdout → HTTP Response（chunked）
```

### CUE 分轨支持

```
请求：GET /api/audio/stream/:id?offset=60000
                                        │
                                        ▼
routes/audio.ts:
  audioPath = track.cueAudioPath ?? track.path   ← 容器文件
  seekOffset = track.cueStartMs ?? offsetMs       ← 分轨偏移
  spawnAudioEngine(audioPath, { offsetMs: seekOffset })
                                        │
                                        ▼
main.c --offset 60000:
  decoder_seek_ms(d, 60000)
    → av_seek_frame(..., AVSEEK_FLAG_BACKWARD)
    → avcodec_flush_buffers()
    → 后续 decoder_read_frame 从偏移处开始输出
```

### 集成方式

**独立 C 二进制 + Node.js 子进程（spawn）**

与项目中 C# scanner、C++ scraper、Rust transcoder/downloader 的模式一致。

```
Node.js 主进程（Hono）         C 子进程（splayer-audio-engine）
     │                              │
     │  spawn(bin, [path, opts])    │
     │─────────────────────────────→│  FFmpeg 解码
     │  ← OGG/Opus chunked          │  → swresample 重采样
     │     (stdout pipe)            │  → libopus 编码 + OGG 封装
     │                              │
     │  stderr ← 日志信息           │
```

### API 端点

```
GET /api/audio/stream/:id?bitrate=128&offset=0
  → OGG/Opus 转码流
  → Content-Type: audio/ogg; codecs=opus
  → Transfer-Encoding: chunked
  → Accept-Ranges: none（不支持 Range seek）

GET /api/audio/status
  → { available: bool, format: "ogg/opus", defaultBitrate: 128000 }

POST /api/audio/control/:id
  → 运行时控制（Phase 3 交互模式）
  → Content-Type: application/json
  → Body: { type: "set_eq", gains: [0,1,0,...], preamp: 0 }
  → 支持的命令：set_eq, set_volume, set_normalization, set_limiter, set_fft,
                set_tempo_speed, set_tempo_pitch, set_tempo, get_status

WebSocket /ws
  → audio:subscribe { streamId: "trackId" }    — 订阅音视频流 FFT 数据
  → audio:unsubscribe { streamId: "trackId" }   — 取消订阅
  → 推送: { type: "audio:fft", data: { bins: 513, data: [-60.0,...] } }
```

**查询参数：**

| 参数 | 类型 | 默认 | 说明 |
|------|------|------|------|
| `bitrate` | number | 128 | Opus 比特率（kbps），clamp 32-512 |
| `channels` | number | 2 | 输出声道数 |
| `offset` | number | 0 | 跳过开头的毫秒数（CUE 分轨） |
| `eq` | string | - | 10 段 EQ 增益（逗号分隔，如 `0,2,0,-1,0,0,0,0,0,0`） |
| `preamp` | number | 0 | 前级增益（dB） |
| `norm` | number | 0 | 响度归一化开关（1=启用） |
| `nolimiter` | number | 0 | 限幅器开关（1=禁用） |
| `fft` | number | 0 | FFT 频谱分析开关（1=启用） |

---

## 前端集成

### 播放路径

```
QualityControl.vue → settings.player.songLevel ("hq")
        ↓
core/player/index.ts load()
  → LoadOptions.qualityLevel = settings.player.songLevel
        ↓
web/api/player.ts load()
  ├─ isLocal && checkAudioEngineStatus()
  │    → toTranscodeUrl(id, "hq")
  │    → /api/audio/stream/:id?bitrate=128
  └─ fallback
       → normalizeSource() → /api/music/stream/:id
```

### QualityLevel → bitrate 映射

| 等级 | bitrate |
|------|---------|
| `hi-res` | 256 kbps |
| `lossless` | 192 kbps |
| `hq`（默认） | 128 kbps |
| `sq` | 96 kbps |
| `lq` | 64 kbps |

---

## 依赖清单

| 依赖 | 用途 | 来源 | Fedora 42 包名 |
|------|------|------|---------------|
| libavformat | 容器格式解析 | RPM Fusion | `ffmpeg-devel` |
| libavcodec | 音频解码 | RPM Fusion | `ffmpeg-devel` |
| libavutil | FFmpeg 工具 | RPM Fusion | `ffmpeg-devel` |
| libswresample | 重采样 | RPM Fusion | `ffmpeg-devel` |
| libopus | Opus 编码 | 系统 | `opus-devel` |

**RPM Fusion 仓库**：Fedora 官方仓库不包含完整 FFmpeg，需启用 RPM Fusion free 仓库。

```bash
# 安装 RPM Fusion 仓库（一次性）
sudo dnf install https://mirrors.rpmfusion.org/free/fedora/rpmfusion-free-release-$(rpm -E %fedora).noarch.rpm
sudo dnf makecache
```

---

## Docker 适配

### fedora-base 阶段

```dockerfile
# 安装 RPM Fusion 仓库（提供 FFmpeg 完整支持）
RUN dnf install -y --setopt=install_weak_deps=False \
      https://mirrors.rpmfusion.org/free/fedora/rpmfusion-free-release-$(rpm -E %fedora).noarch.rpm && \
    dnf makecache
```

### Build 层

```dockerfile
FROM fedora-base AS audio-engine-builder
RUN dnf install -y --setopt=install_weak_deps=False \
      gcc make cmake \
      ffmpeg-devel && \
    dnf clean all

COPY server/audio-engine/ /app/audio-engine/
RUN cd /app/audio-engine && \
    cmake -B build -DCMAKE_BUILD_TYPE=Release && \
    cmake --build build -j$(nproc) && \
    cp build/splayer-audio-engine /out/
```

### Runtime 层

```dockerfile
FROM fedora-base AS runtime
RUN dnf install -y --setopt=install_weak_deps=False \
      nodejs npm tini openssl sqlite-libs \
      libstdc++ zlib-ng taglib \
      ffmpeg-libs && \
    dnf clean all

COPY --from=audio-engine-builder /out/splayer-audio-engine /app/bin/
ENV SPLAYER_AUDIO_ENGINE=/app/bin/splayer-audio-engine
```

---

## 与现有架构的关系

| 组件 | 是否替换 | 说明 |
|------|---------|------|
| `serveAudioStream` (TS) | **保留** | 原始文件流作为回退路径 |
| `subsonic-transcoder` (Rust) | **保留** | 专用于 Subsonic 协议，不影响 |
| `web/api/player.ts` (WebAudio) | **已集成** | 引擎可用时走转码路径，参数通过 URL 传递；不可用时回退到浏览器端处理 |
| `native/audio-engine` (Rust) | **不变** | 仅 Electron 客户端使用 |
| C# scanner | **不变** | 元数据扫描不冲突 |
| C++ scraper | **不变** | 封面刮削不冲突 |

### 前端处理逻辑

```typescript
// web/api/player.ts
const isLocal = options?.meta?.source === "local" && !!options?.meta?.id;
if (isLocal && await checkAudioEngineStatus()) {
  // 服务端转码路径：EQ/响度参数通过 URL 传递
  url = toTranscodeUrl(id, level, normalization, eqEnabled, eqGains, preampDb);
  this.useServerProcessing = true;  // 跳过浏览器端处理
} else {
  // 回退路径：浏览器端处理
  url = normalizeSource(source, options?.meta);
  this.useServerProcessing = false;  // 启用浏览器端 EQ/响度
}
```

---

## 实现计划

### Phase 1：核心管线 ✅ 已完成

```
decoder → resampler → encoder
```

- [x] C 核心：decoder / resampler / encoder / pipeline / CLI
- [x] CMake 构建系统
- [x] TS binding（spawn 子进程）
- [x] 路由端点 + 前端 qualityLevel 映射
- [x] CUE 分轨 offset 支持

### Phase 2：音频处理管线 ✅ 已完成

```
decoder → resampler → equalizer → loudness → limiter → fft → encoder
```

- [x] `equalizer.c`：10 段 Biquad IIR 滤波（31.25Hz ~ 16kHz ISO 标准频段，Audio EQ Cookbook 公式）
- [x] `loudness.c`：EBU R128 预计算增益补偿（避免实时延迟）
- [x] `limiter.c`：Soft-knee 限幅（4:1 压缩比，默认 -1dB 阈值）
- [x] `fft.c`：Hann 窗 + DFT 频谱分析（50% 重叠）
- [x] CLI 参数：`--eq` `--preamp` `--normalization` `--no-limiter` `--fft`
- [x] 路由查询参数：`eq` `preamp` `norm` `nolimiter` `fft`
- [x] TS binding 参数传递

### Phase 3：交互控制 ✅ 已完成

- [x] 运行时 EQ 参数调整（通过 stdin JSON 控制消息）
- [x] 运行时音量调整
- [x] 运行时 normalization / limiter / FFT 开关
- [x] FFT 数据实时推送（WebSocket 旁路，`audio:subscribe` / `audio:unsubscribe` 协议）
- [x] position/duration 查询（`get_status` 命令）
- [x] control-fd / fft-fd 协议（fd 3/4 JSON 行协议）
- [x] `binding.ts`：`InteractiveAudioEngine` 类 + 全局引擎管理
- [x] `routes/audio.ts`：`POST /control/:id` 运行时控制端点
- [x] `routes/ws.ts`：`broadcastToStream()` + 审计流订阅管理

### Phase 4：变速变调 + Web 端迁移 ✅ 已完成

- [x] 前端自动检测引擎可用性（`/api/audio/status`）
- [x] 引擎可用时走转码路径，参数通过 URL 传递
- [x] 引擎不可用时回退到浏览器端处理（保留 EQ/loudness/FFT）
- [x] `tempo-rs/` — Rust signalsmith-stretch C FFI 静态库
- [x] `tempo.c/h` — C 封装 + HAS_TEMPO 条件编译（无 cargo 时 stub bypass）
- [x] Pipeline 集成：`decoder → resampler → eq → loudness → limiter → tempo → fft → encoder`
- [x] CLI 参数：`--tempo` `--tempo-speed` `--tempo-pitch` `--tempo-pitch-sync`
- [x] 交互命令：`set_tempo_speed` `set_tempo_pitch` `set_tempo`
- [x] Dockerfile 更新：`audio-engine-builder` 阶段添加 `cargo rustc`

---

## 成功标准

1. **构建零网络下载**：`dnf install` + 仓库内 C 代码，无 `cargo fetch` / 无 FFmpeg 静态库下载
2. **功能等价**：EQ 10 段、EBU R128 响度归一化、FFT 128 频段、限幅器、变速变调
3. **Web 端迁移**：浏览器 `WebAudioPlayer` 中 EQ/loudness/FFT 代码可删除
4. **延迟可接受**：转码延迟 < 500ms（Opus 编码 + chunked HTTP）
5. **上游解耦**：桌面端 `audio-engine` 破坏性修改不影响 Web 端
