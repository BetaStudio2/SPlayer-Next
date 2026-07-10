# 服务端第三方许可证声明（Server / @splayer/server）

本目录为 SPlayer-Next 的 Node.js 服务端（Hono），随本软件以 AGPL-3.0 授权。
以下为其直接运行时依赖的第三方组件许可证摘要。
完整许可证文本由各上游项目在其仓库中提供；MIT/BSD/ISC 类许可证仅需在分发时
附具版权与许可声明，本文件已归集。

## 子系统与代码来源声明

- 本目录为 **SPlayer-Next**（仓库：https://github.com/SPlayer-Dev/SPlayer-Next，
  许可证：AGPL-3.0）的 Node.js 服务端子系统，
  随本软件整体以 AGPL-3.0 授权。
- 本服务端子系统源于对桌面端程序的二次修改与架构扩展，对原程序的修改采取**双轨**方式：
  1. 以**组件形式**承载的扩展能力；
  2. 对原程序既有文件（如 `src/core/player/`、`web/api/`、`shared/types/` 等）
     直接进行的功能编排，例如 EQ 均衡器、响度归一化、服务端转码路径下的
     音频处理等播放特效与处理能力。该等修改直接落入本仓库 AGPL-3.0 源码树内，
     属本软件对原桌面端程序的修改，整体仍以 AGPL-3.0 授权。

## 与桌面端 / Web 端的代码混合范围

本服务端并非自包含代码库，而是与同一仓库内的桌面端、Web 端共享以下源码：

1. **Web 管理界面（`web/`）**：其 Vite 构建将 `@` 别名指向根目录 `src/`
   （桌面端 renderer 源码），即服务端 Web 界面**直接复用桌面端 `src/` 的 Vue 组件与逻辑**。
   该部分为上游 AGPL-3.0 作品的原生代码，经此引用进入服务端分发物。
2. **共享类型与工具（`shared/`）**：服务端经 `@shared/*` 引用同一仓库的
   `shared/types/*`（纯类型定义）与 `shared/utils/*`（如 `path.ts` 小型工具函数），
   与桌面端、Web 端共用同一份源码。
3. **对原程序的直接功能增强**：除组件形态外，本服务端子系统还在原程序既有文件内
   直接增改功能（如 `src/core/player/`、`web/api/`、`shared/types/` 下的
   EQ 均衡器、响度归一化、服务端转码路径下的音频处理等播放特效与处理能力）。
   该等修改落入本仓库 AGPL-3.0 源码树内，属本软件对原桌面端程序的修改。

上述第 1、2 项所涉代码均为同一 AGPL-3.0 仓库内的上游源码，
其许可证与本项目一致（AGPL-3.0），不构成跨许可证兼容问题；
其原始版权与许可声明以仓库根 `LICENSE` 及上游仓库为准。

## 覆盖范围

本声明（及 `THIRD-PARTY-NOTICES.md`）覆盖 **`server/` 子树及其协同运行的原生子系统**
（Go / C# / C++ / Rust 后端），以及经上述方式共享的 `shared/` 类型与本仓库 Web 界面。
桌面端 Electron 主程序与原生 `.node` 模块的许可证义务，由各自对应的声明文件
（见 `native/THIRD-PARTY-LICENSES.md` 等）另行说明。

## 直接依赖

| 组件 | 版本 | 许可证 | 说明 |
|---|---|---|---|
| `@hono/node-server` | ^1.13.7 | MIT | Node.js 适配层 |
| `hono` | ^4.6.14 | MIT | Web 框架 |
| `better-sqlite3` | ^12.8.0 | MIT | SQLite 绑定（原生，动态链接系统/打包 SQLite） |
| `atomically` | ^2.0.3 | MIT | 原子文件写入 |
| `chokidar` | ^4.0.3 | MIT | 文件系统监听 |
| `music-metadata` | ^11.0.2 | MIT | 音频元数据解析（及其传递依赖，见下） |
| `undici` | ^8.7.0 | MIT | HTTP 客户端 |
| `ws` | ^8.21.0 | MIT | WebSocket |

### `music-metadata` 传递依赖（均为 MIT）

`@borewit/text-codec`、`@tokenizer/token`、`@tokenizer/token` 系列、
`content-type`、`debug`、`file-type`、`media-typer`、`strtok3`、`token-types`、
`uint8array-extras` 等，全部以 MIT 许可证发布，与 AGPL-3.0 兼容。

## 许可兼容性结论

服务端所有 JavaScript/TypeScript 依赖均为 MIT 许可证，
与本项目 AGPL-3.0 完全兼容，无 copyleft 冲突。
服务端通过 `@main/*`、`@shared/*` 别名复用同一仓库内的 AGPL-3.0 源码，
整体作为同一受保护作品（covered work）分发。

## 关联原生子系统

本服务端在 Docker 全栈镜像中与以下原生子系统协同运行，
各自的第三方许可证声明见对应目录下的 `THIRD-PARTY-LICENSES.md`：

- `server/subsonic/` —— Subsonic Go 后端
- `server/subsonic/subsonic-transcoder/` —— Rust 转码器（静态链接 LAME，LGPL）
- `server/scanner/` —— C# 曲库扫描器（TagLibSharp，LGPL）
- `server/scraper/` —— C++ 刮削器（TagLib / libcurl / OpenSSL / SQLite3）
- `server/audio-engine/` —— Rust 服务端音频引擎（FFmpeg，LGPL）

---
AGPL-3.0 完整文本见仓库根 `LICENSE`；第三方声明总览见根 `THIRD-PARTY-NOTICES.md`。
