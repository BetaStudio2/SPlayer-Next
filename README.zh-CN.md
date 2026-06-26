<div align="center">

<img alt="SPlayer-Next logo" width="120" height="120" src="public/icons/favicon.png" />

<h2>SPlayer-Next</h2>

<p>🎵 跨平台音乐播放器，桌面端 + Web 服务端，支持丰富歌词与广泛音频格式</p>

<p>「<a href="https://github.com/SPlayer-Dev/SPlayer">SPlayer</a>」的继任版本</p>

[![Stars](https://img.shields.io/github/stars/SPlayer-Dev/SPlayer-Next?style=flat)](https://github.com/SPlayer-Dev/SPlayer-Next/stargazers)
[![Release](https://img.shields.io/github/v/release/SPlayer-Dev/SPlayer-Next)](https://github.com/SPlayer-Dev/SPlayer-Next/releases)
[![License](https://img.shields.io/github/license/SPlayer-Dev/SPlayer-Next)](https://github.com/SPlayer-Dev/SPlayer-Next/blob/main/LICENSE)
[![Issues](https://img.shields.io/github/issues/SPlayer-Dev/SPlayer-Next)](https://github.com/SPlayer-Dev/SPlayer-Next/issues)

[English](./README.md) | **简体中文**

</div>

---

## 功能特性

- 🎵 **广泛的格式支持** —— MP3、FLAC、WAV、AAC、OGG、APE 等，基于 FFmpeg 解码
- 📝 **丰富的歌词** —— LRC / QRC / YRC / TTML，逐字高亮与翻译，支持桌面、灵动岛、任务栏歌词窗口
- 🌐 **流媒体服务** —— Subsonic / Navidrome / Jellyfin / Emby（多服务器、自动连接）
- 🖥️ **跨平台** —— Windows / macOS / Linux
- 🎚️ **音乐频谱** —— 实时 FFT 可视化
- 🏷️ **元信息编辑** —— 编辑本地曲目标签与封面
- ⬇️ **下载** —— 内置下载管理器
- 🎧 **系统媒体集成** —— Windows SMTC / Linux MPRIS / macOS Now Playing + Discord RPC
- ⚡ **高性能音频引擎** —— FFmpeg + Rust
- 🎨 **自适应主题** —— 基于封面取色，Light / Dark / Auto
- 📈 **Last.fm Scrobble**
- 🐳 **Web 服务端部署** —— 纯 Web SPA + Node 流媒体后端，Docker 单容器部署，浏览器即用

## 开发

### 环境要求

- **Node.js** >= 22
- **pnpm** >= 10
- **Rust 工具链**（构建原生模块所需，见下）

### 原生模块

核心性能特性由 Rust 编写的原生模块提供：

| 模块            | 说明                                               |
| --------------- | -------------------------------------------------- |
| `audio-engine`  | 高性能音频解码（FFmpeg）、播放、FFT 频谱、封面提取 |
| `media-ctrl`    | 系统媒体控制 + Discord Rich Presence               |
| `taskbar-lyric` | Windows 任务栏歌词原生渲染                         |

`pnpm dev` 与 `pnpm build` 会自动编译原生模块。若只做 UI 开发想跳过，可设置 `SKIP_NATIVE_BUILD=true`。

### 快速开始

```bash
# 1. 安装依赖
pnpm install

# 2. 启动开发（先以 debug 构建原生模块，再启动 Electron）
pnpm dev
```

### 构建

```bash
pnpm build         # 完整构建：清理 → 原生模块 → 类型检查 → electron-vite

pnpm build:win     # 打包 Windows
pnpm build:mac     # 打包 macOS
pnpm build:linux   # 打包 Linux
```

> 默认仅构建当前架构。如需指定架构，可追加参数，例如 `pnpm build:win --x64 --arm64`。

### 其他脚本

```bash
pnpm typecheck        # tsc + vue-tsc（node + web 双目标）
pnpm lint             # ESLint
pnpm format           # Prettier
pnpm build:native     # 仅构建 Rust 原生模块（加 `--dev` 为 debug 构建）
```

## Web 服务端部署（Docker / 原生）

除桌面端外，本项目亦可作为 **自包含 Web 流媒体服务** 运行：浏览器访问即用，无需安装客户端。Web 化零侵入——`src/` 前端代码零修改，新增 `server/`（Hono + SQLite + 流媒体引擎）与 `web/`（`window.api` Mock 层）两个独立目录。

### 架构

```
浏览器（Vue 3 SPA）              服务端（Node.js Hono :8080）
┌────────────────────┐          ┌────────────────────────────┐
│  src/（零修改）     │  HTTP    │  /api/music/*  流媒体引擎    │
│  调用 window.api.*  │ ──────→  │  /api/proxy/*  在线 API 代理 │
│                    │          │  /api/lyric/*  歌词匹配      │
│  web/api Mock 层    │  WS      │  /api/config/* 配置持久化    │
│  把 window.api 转为 │ ←──────  │  /ws           实时事件推送  │
│  fetch / WS 调用    │          │  /*            SPA 静态分发  │
└────────────────────┘          └────────────────────────────┘
```

### Docker 部署（推荐）

```bash
# 1. 准备音乐库与数据目录
mkdir -p music data && cp /path/to/your/music/*.mp3 music/

# 2. 构建并启动（单容器，端口 8080 同时提供 SPA + API + WS）
docker compose up -d --build

# 3. 浏览器访问 http://<服务器IP>:8080
```

挂载卷：`./music`（音乐库，只读）+ `./data`（SQLite / 配置 / 封面缓存，持久化）。详见 [DEPLOY.md](./DEPLOY.md)。

### 原生运行（开发 / 调试）

```bash
# 后端（:8080）
cd server && npm install && npm run dev

# 前端（:14558，/api 与 /ws 自动代理到 8080）
cd web && npm install && npm run dev
```

### 与桌面端的差异

| 能力 | 桌面端 | Web 服务端 |
|:----|:------|:----------|
| 音频解码 | Rust + FFmpeg | HTML5 `<audio>` + Web Audio API |
| 本地曲库 | 本地文件直读 | HTTP Range 流媒体（挂载 `/app/music`） |
| 实时事件 | IPC | WebSocket（`/ws`，扫描进度 / 库变更推送） |
| 下载 | 本地磁盘 | 浏览器 Blob 下载（可选服务端缓存模式） |
| 桌面歌词 / SMTC / 系统托盘 | ✓ | 桌面端专有，Web 版以 stub 降级 |

## 致谢

特别感谢以下让 SPlayer-Next 成为可能的开源项目：

- [applemusic-like-lyrics](https://github.com/Steve-xmh/applemusic-like-lyrics) —— 类 Apple Music 歌词显示组件库
- [NeteaseCloudMusicApiEnhanced](https://github.com/neteasecloudmusicapienhanced/api-enhanced) —— 网易云音乐 API 备份 + 增强
- [Navidrome](https://github.com/navidrome/navidrome) —— Web 服务端的 HTTP Range 流媒体实现参考

## 开源许可

本项目基于 [GNU Affero General Public License v3.0 (AGPL-3.0)](https://www.gnu.org/licenses/agpl-3.0.html) 许可开源。

- **修改与分发：** 任何修改或分发都必须同样基于 **AGPL-3.0**，并一并提供完整源代码。
- **派生作品：** 必须同样采用 **AGPL-3.0**，并在适当位置保留本项目的许可与版权信息。
- **署名：** 必须保留原作者及版权信息。可为二次开发添加你自己的署名，但不得移除或篡改原始信息。
- **商业用途：** 如用于售卖或其他盈利用途，必须提供源代码及原项目链接。由于本项目涉及第三方服务，商业使用可能存在法律风险。
- **免责：** 本软件按「现状」提供，不附带任何形式的担保，详见 AGPL-3.0。

## 免责声明

本项目仅供个人学习与研究使用，禁止用于商业及非法用途。部分功能依赖第三方 API，使用者须自行确保其使用符合相关法律法规及服务协议。对于因使用本项目而产生的任何直接或间接后果，作者不承担任何责任。
