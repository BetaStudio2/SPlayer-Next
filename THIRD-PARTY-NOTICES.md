# 第三方许可证声明（Third-Party Notices）

本仓库以 **GNU Affero General Public License v3.0（AGPL-3.0）** 整体授权，
完整许可证文本见同级 `LICENSE` 文件。

本软件采用混合架构分发，包含 Electron 桌面程序、独立 Node.js 服务端，
以及以 Go / C# / C++ / Rust 编写的多个原生后端子系统。
这些子系统各自聚合了以 MIT、BSD、Apache-2.0、MPL-2.0、LGPL-2.1、LGPL-3.0
等许可证发布的第三方组件。上述许可证均与 AGPL-3.0 兼容，
但其中 **LGPL / MPL 等弱拷贝左（weak copyleft）组件** 在随本软件分发时，
须随附其许可证文本与相应声明，本文档即为此目的而设。

## 服务端子系统来源

- 本仓库的**服务端子树（`server/` 及其协同原生子系统）源于对桌面端 SPlayer-Next
  （AGPL-3.0）的二次修改与架构扩展**。
- 整体遵循本仓库的 AGPL-3.0 授权；服务端 Web 界面复用同一仓库桌面端 `src/` 源码、
  并与 `shared/` 共享类型/工具，详见 `server/THIRD-PARTY-LICENSES.md` 的「代码混合范围」一节。
- 桌面端 Electron 主程序与原生 `.node` 模块的许可证义务，由各自对应的声明文件另行说明。

各子系统的第三方许可证明细，按其源码目录分别存放于：

| 子系统 | 声明文件位置 |
|---|---|
| Electron 桌面程序（含 audio-engine / media-ctrl / taskbar-lyric / download-engine 原生模块） | `native/THIRD-PARTY-LICENSES.md` |
| Node.js 服务端（整体） | `server/THIRD-PARTY-LICENSES.md` |
| Subsonic Go 后端 | `server/subsonic/THIRD-PARTY-LICENSES.md` |
| Subsonic 转码器（Rust，静态链接 LAME） | `server/subsonic/subsonic-transcoder/THIRD-PARTY-LICENSES.md` |
| 曲库扫描器（C# / .NET，TagLibSharp） | `server/scanner/THIRD-PARTY-LICENSES.md` |
| 刮削器（C++，TagLib / libcurl / OpenSSL / SQLite3） | `server/scraper/THIRD-PARTY-LICENSES.md` |
| 服务端音频引擎（Rust） | `server/audio-engine/THIRD-PARTY-LICENSES.md` |

## AGPL-3.0 第 13 条（网络交互条款）源码获取说明

当本软件的修改版本以网络服务形式（包括但不限于 Docker 镜像运行的
Subsonic API / Web 服务）向用户提供交互时，依据 AGPL-3.0 第 13 条，
运营方须向该等用户提供其所运行版本的**完整对应源代码**。

本软件源代码公开发布于：

- 仓库地址：https://github.com/SPlayer-Dev/SPlayer-Next
- 许可证：AGPL-3.0

所有原生后端（Go / C# / C++ / Rust）的源码均包含于上述公开仓库的
`server/` 目录及其子目录中，可供重新构建。

## 静态链接组件的特别声明（LGPL 可重链）

`server/subsonic/subsonic-transcoder` 通过 `mp3lame-encoder` → `mp3lame-sys`
将 **LAME（LGPL-2.1+）** 以静态库形式链接进其二进制。
依据 LGPL-2.1 第 6 条，该二进制被视为对 LAME 库的修改作品，
使用者有权：(a) 获得 LAME 的相应源代码；(b) 以修改后的 LAME 重新链接该二进制。

LAME 源代码获取地址：https://sourceforge.io/projects/lame/
本软件对应版本的构建方式（含所用 LAME 版本）见公开仓库 `server/subsonic/subsonic-transcoder/`。

---
本声明随 AGPL-3.0 第 4、5 条及 LGPL-2.1 第 6 条、MPL-2.0 要求一并提供。
