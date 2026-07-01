# SPlayer 项目结构总览

> **更新：2026-06-30 | 基于实际代码库 v2**
>
> SPlayer 是一个跨平台音乐播放器，采用 Electron 桌面壳 + Vue 3 前端的架构，
> 后端由 TypeScript API 集成层、Go Subsonic 协议层、C++ 元数据刮削器、
> C# 音乐扫描引擎和多语言 Native 模块（Rust）共同组成。
>
> 模块间通过 localhost HTTP 通信，SQLite 写入统一由 TS 层代理避免多进程冲突。

---

## 一、项目顶层结构

```
SPlayer-Next/
├── src/                  [Electron 主进程]  桌面应用壳 + IPC + 窗口管理
├── server/               [TS 后端]          Hono API 服务 + SQLite 写入代理
├── web/                  [Vue 3 前端]       Vite + UnoCSS + Pinia + Reka UI
├── native/               [Rust 原生模块]    napi-rs 与独立二进制
│   ├── audio-engine/     [Rust]  音频播放引擎（napi-rs）
│   ├── download-engine/  [Rust]  流式下载引擎（独立 CLI 二进制）
│   ├── media-ctrl/       [Rust]  系统媒体控制器（napi-rs）
│   ├── taskbar-lyric/    [Rust]  任务栏歌词（Windows napi-rs）
│   └── taskbar-thumbnail/[Rust]  任务栏缩略图（Windows napi-rs）
├── scraper-cpp/          [C++]   元数据刮削器（独立 CLI 二进制）
├── scanner-cs/           [C#]    音乐扫描引擎（TagLibSharp）
├── subsonic-go/          [Go]    Subsonic 协议层
├── shared/               [TS]    前后端共享类型与工具
├── windows/              [Vue 3] 独立窗口应用（桌面歌词、Dynamic Island）
├── electron/             [配置]  electron-builder 打包配置
├── docs/                 [文档]  规划与说明文档
├── scripts/              [脚本]  构建与部署脚本
├── public/               [静态]  公共资源
├── demo/                 [示例]  示例文件
├── dist/                 [输出]  ESBuild 打包输出
├── out/                  [输出]  Electron 构建输出
└── node_modules/
```

---

## 二、模块清单

### 2.1 Electron 主进程（`src/`）— 桌面应用壳

框架：Electron + TypeScript，负责窗口管理、IPC 通信、系统托盘、原生菜单。

```
src/
├── main.ts                              # Electron 入口
├── preload.ts                           # 预加载脚本
├── env.d.ts
├── core/
│   ├── player/
│   │   ├── index.ts                     # 播放器核心
│   │   ├── events.ts                   # 播放事件
│   │   ├── fm.ts                        # FM 模式
│   │   └── stats.ts                    # 播放统计
│   └── hotkey/
│       ├── manager.ts                   # 全局热键管理
│       ├── recorder.ts                 # 热键录制
│       └── registry.ts                 # 热键注册
├── composables/                         # Vue composables（共享逻辑）
│   ├── collection/                      # 收藏相关
│   ├── home/                            # 首页相关
│   ├── useCacheStats.ts
│   ├── useCopyText.ts
│   ├── useDialog.ts
│   ├── useDownload.ts
│   ├── useDragSort.ts
│   ├── useFavorite.ts
│   ├── useFloatingPlayerBar.ts
│   ├── useFmMode.ts
│   ├── useHeartMode.ts
│   ├── useImmersiveMode.ts
│   ├── useMultiSelect.ts
│   ├── useOrpheusProtocol.ts
│   ├── usePlaybackTime.ts
│   ├── usePlaylistPicker.ts
│   ├── useQueuePanel.ts
│   ├── useSystemFonts.ts
│   ├── useToast.ts
│   ├── useTrackMenu.ts
│   └── useWindowControls.ts
├── services/                            # 业务服务
│   ├── scraper.ts                       # 刮削器调度
│   ├── playback.ts                      # 播放控制
│   ├── audioSource.ts                   # 音频源选择
│   ├── artistLoader.ts                  # 艺术家加载
│   ├── collectionLoader.ts
│   ├── cacheScheduler.ts               # 缓存调度
│   ├── downloadLyric.ts                # 歌词下载
│   ├── downloadSource.ts
│   ├── fftCapture.ts
│   ├── lyricLoader.ts
│   ├── orpheus.ts
│   ├── abLoop.ts
│   ├── autoClose.ts
│   ├── subsonic-admin.ts
│   ├── streaming/                       # 流媒体服务适配
│   │   ├── index.ts
│   │   ├── subsonic.ts
│   │   ├── emby.ts
│   │   ├── jellyfin.ts
│   │   ├── http.ts
│   │   ├── session.ts
│   │   └── errors.ts
│   └── ws.ts                            # WebSocket 客户端
├── stores/                              # Pinia 状态管理
│   ├── library.ts                       # 音乐库状态
│   ├── queue.ts                         # 播放队列
│   ├── player.ts                        # 播放器状态
│   ├── settings.ts                      # 设置
│   ├── data.ts
│   ├── download.ts
│   ├── history.ts
│   ├── hotkey.ts
│   ├── media.ts
│   ├── playlist.ts
│   ├── plugins.ts
│   ├── status.ts
│   ├── streaming.ts
│   ├── theme.ts
│   ├── update.ts
│   ├── user.ts
│   └── cloudUpload.ts
├── pages/                               # 页面视图
│   ├── Home.vue                         # 首页
│   ├── Library.vue                      # 音乐库
│   ├── Search.vue                       # 搜索
│   ├── Artist.vue                       # 艺术家详情
│   ├── Collection.vue                   # 收藏集
│   ├── Download.vue                     # 下载管理
│   ├── LocalList.vue                    # 本地列表
│   ├── Folders.vue                      # 文件夹浏览
│   ├── Favorites.vue                    # 收藏
│   ├── Liked.vue                        # 我喜欢
│   ├── History.vue                      # 播放历史
│   ├── Cloud.vue                        # 云盘
│   ├── Daily.vue                        # 每日推荐
│   ├── Onboarding.vue                   # 引导页
│   └── Streaming/                       # 流媒体浏览
│       ├── Index.vue
│       ├── Albums.vue
│       ├── Artists.vue
│       ├── Songs.vue
│       └── Playlists.vue
├── components/                          # 可复用组件
│   ├── ui/                              # 基础 UI 组件
│   ├── layout/                          # 布局组件
│   ├── player/                          # 播放器组件
│   ├── library/                         # 音乐库组件（含 ScrapeFolderManager）
│   ├── list/                            # 列表组件
│   ├── modals/                          # 弹窗组件
│   ├── settings/                        # 设置面板组件
│   ├── onboarding/                      # 引导组件
│   ├── AppBackground.vue
│   └── SPerformanceMonitor.vue
├── router/                              # Vue Router
│   └── index.ts
├── settings/                            # 设置框架
│   ├── schema.ts
│   ├── useSettingModel.ts
│   ├── useSettingsDialog.ts
│   └── categories/
│       ├── general.ts                   # 常规
│       ├── appearance.ts                # 外观
│       ├── player.ts                    # 播放
│       ├── lyric.ts                     # 歌词
│       ├── download.ts                  # 下载
│       ├── services.ts                  # 服务
│       ├── streaming.ts                 # 流媒体
│       ├── plugins.ts                   # 插件
│       ├── hotkeys.ts                   # 热键
│       ├── localCache.ts               # 本地缓存
│       └── externalLyric.ts            # 外部歌词
├── i18n/                                # 国际化
│   ├── index.ts
│   └── locales/
│       ├── zh-CN.json
│       └── en-US.json
├── styles/                              # 全局样式
│   ├── global.css
│   └── markdown.css
├── types/                               # 类型定义
│   ├── artist.ts
│   ├── collection.ts
│   ├── folder.ts
│   ├── netease.ts
│   ├── settings.ts
│   ├── settings-schema.ts
│   ├── theme.ts
│   └── user.ts
├── utils/                               # 工具函数
│   ├── format.ts
│   ├── color.ts
│   ├── config.ts
│   ├── md5.ts
│   ├── time.ts
│   ├── url.ts
│   ├── navigate.ts
│   ├── quality.ts
│   ├── errors.ts
│   ├── folderTree.ts
│   ├── tagMatch.ts
│   ├── format/
│   │   ├── coverItem.ts
│   │   ├── netease.ts
│   │   └── shareUrl.ts
│   └── lyric/
│       ├── parse.ts                     # 统一歌词解析入口
│       ├── parseLRC.ts                  # LRC 解析
│       ├── parseKRC.ts                  # 酷狗 KRC 解析
│       ├── parseQRC.ts                  # QQ 音乐 QRC 解析
│       ├── parseYRC.ts                  # 网易云 YRC 解析
│       ├── parseASS.ts                  # ASS 字幕格式
│       ├── parseSRT.ts                  # SRT 字幕格式
│       ├── parseLyS.ts                  # LyS 格式
│       ├── parseTTML.ts                 # TTML 格式
│       ├── serialize.ts                 # 序列化
│       ├── timestamp.ts                 # 时间戳工具
│       ├── author.ts                    # 歌词作者
│       ├── normalize.ts                 # 规范化为 LRC
│       ├── lyricStripper.ts             # 纯文本提取
│       ├── poster.ts                    # 歌词海报
│       ├── bg.ts                        # 歌词背景
│       └── excludeRules.ts              # 排除规则
├── directives/
│   └── ripple.ts                        # 涟漪动画指令
└── layouts/
    └── MainLayout.vue                   # 主布局
```

### 2.2 TS 后端（`server/`）— API 集成层 + SQLite 写入代理

框架：Hono + better-sqlite3 + esbuild。

**依赖说明**：此模块**永久保留**，不做迁移。
- `server/apis/netease/`（60+ 模块 + weapi/linuxapi 加密）— ⛔ 禁止重构
- `server/apis/qqmusic/`（TripleDES + RC4 + 自定义加密）— ⛔ 禁止重构
- `server/apis/kugou/`（KRC 歌词解析 + 专有加密）— ⛔ 禁止重构
- 所有子进程通过 HTTP 到此模块进行 SQLite 写入

```
server/
├── index.ts                      # Hono 入口 + 路由注册 + 静态文件服务
├── store.ts                      # 配置存储
├── build.mjs                     # ESBuild 打包脚本
├── package.json
├── tsconfig.json
├── database/                     # 数据库层（永久保留）
│   ├── index.ts                  # 连接管理 + 建表（WAL 模式）
│   ├── migration.ts              # Schema 迁移
│   ├── queries.ts                # CRUD + 聚合查询
│   ├── subsonic.ts               # Subsonic 专用 CRUD
│   ├── downloads.ts              # 下载任务持久化
│   ├── sessions.ts               # 会话 cookie 存储
│   ├── lyricCache.ts             # 歌词缓存
│   ├── lyricMatchCache.ts        # 歌词匹配缓存
│   └── lyricTtmlCache.ts         # TTML 歌词缓存
├── music/                        # 音乐库管理
│   ├── scanner.ts                # C# scanner 调度封装（spawn 子进程）
│   ├── scraper.ts                # C++ scraper 调度封装（spawn 子进程）
│   ├── watcher.ts                # chokidar 文件变更监听
│   ├── database.ts               # 音乐库统计
│   ├── serve.ts                  # 本地音频流式读取（HTTP Range）
│   └── organizer.ts              # 文件整理（按艺术家/专辑归类）
├── routes/                       # HTTP 路由
│   ├── db.ts                     # SQLite 写入代理（POST /api/db/*）
│   ├── subsonic.ts               # Subsonic 协议（~850 行）
│   ├── subsonic-proxy.ts         # Subsonic 反向代理
│   ├── subsonic-admin.ts         # Subsonic 管理面板 API
│   ├── music.ts                  # 音乐库管理 API
│   ├── scraper.ts                # 刮削任务 API
│   ├── download.ts               # 下载任务 API
│   ├── lyric.ts                  # 歌词匹配 API
│   ├── streaming.ts              # 流媒体凭据 CRUD
│   ├── proxy.ts                  # 在线音乐 API 代理
│   ├── config.ts                 # 系统配置 API
│   └── ws.ts                     # WebSocket 管理
├── apis/                         # 第三方 API 集成（⛔ 禁止重构）
│   ├── netease/                  # 网易云全量 API（60+ 模块）
│   ├── qqmusic/                  # QQ 音乐 API
│   ├── kugou/                    # 酷狗 API
│   ├── common/lyric/             # 统一歌词管道
│   └── musicbrainz.ts            # 歌手头像刮削（旧版）
├── config/                       # 配置管理
│   ├── store.ts
│   ├── types.ts
│   ├── utils.ts
│   └── migrations.ts
├── utils/                        # 工具
│   ├── config.ts
│   ├── crypto.ts
│   ├── events.ts
│   ├── logger.ts
│   ├── paths.ts
│   └── protocol.ts
├── dist/                         # ESBuild 构建产物
│   └── index.js
└── data/                         # 运行时数据
    ├── database/library.db       # SQLite 数据库
    ├── config/settings.json      # 用户配置
    ├── cache/covers/             # 封面缓存
    ├── cache/artists/            # 艺术家图片缓存
    ├── music/                    # 音乐文件
    └── downloads/                # 下载文件
```

### 2.3 Vue 3 前端（`web/`）

框架：Vite + Vue 3 + UnoCSS + Pinia + Vue Router + Reka UI + Vue i18n。

```
web/
├── main.ts                       # Vue 入口
├── index.html                    # HTML 模板
├── package.json
├── tsconfig.json
├── vite.config.ts                # Vite 配置
├── uno.config.ts                 # UnoCSS 配置
├── auto-imports.d.ts             # 自动导入类型
├── components.d.ts               # 组件类型
├── api/                          # API 客户端
│   ├── index.ts                  # HTTP 客户端封装
│   ├── apis.ts                   # 统一 API 注册
│   ├── ws.ts                     # WebSocket 客户端
│   ├── config.ts
│   ├── download.ts
│   ├── hotkey.ts
│   ├── library.ts
│   ├── lyrics.ts
│   ├── player.ts
│   ├── stats.ts
│   ├── streaming.ts
│   ├── stubs.ts
│   ├── system.ts
│   ├── theme.ts
│   └── cache.ts
└── node_modules/
```

### 2.4 C++ 元数据刮削器（`scraper-cpp/`）— 独立 CLI 二进制

状态：**已实现**（header-only 设计，无 .cpp 编译单元）。
构建：CMake + g++（需 libcurl、OpenSSL、TagLib、nlohmann/json）。
功能：多源并发元数据刮削（MusicBrainz、Deezer、iTunes、网易云、QQ 音乐、酷狗、酷我、咪咕）。

```
scraper-cpp/
├── CMakeLists.txt
├── cmake/
│   └── FindTaglib.cmake          # CMake 查找 TagLib 模块
├── include/                      # header-only 实现
│   ├── scraper.h                 # 数据结构定义（TrackInfo / ScrapeResult / ScraperConfig）
│   ├── api_client.h              # 多源 API 客户端 + ThreadPool + MetadataResolver
│   │   ├── MusicBrainzClient     # MusicBrainz 查询 + 详细元数据（genre/label/composer/ISRC）
│   │   ├── CoverArtArchiveClient # 专辑封面获取
│   │   ├── LrclibClient          # LRCLIB 歌词
│   │   ├── DeezerClient          # Deezer 搜索（元数据 + 封面）
│   │   ├── ItunesClient          # iTunes Search（元数据 + 封面 + 流派）
│   │   ├── ChineseMusicClientBase# 中文源抽象基类（匹配评分 + URL 编码）
│   │   ├── NeteaseClient         # 网易云 weapi 加密搜索 + 歌词
│   │   ├── QQMusicClient         # QQ 音乐 musicu.fcg 搜索 + 歌词
│   │   ├── KugouClient           # 酷狗 MD5 签名搜索 + 歌词
│   │   ├── KuwoClient            # 酷我 Cross 头搜索 + 歌词
│   │   ├── MiguClient            # 咪咕搜索 + 歌词
│   │   ├── ThreadPool            # C++17 线程池（并发 HTTP 请求）
│   │   └── MetadataResolver      # 多源合并引擎（评分匹配 + 封面/歌词获取）
│   ├── db_client.h               # HTTP 代理客户端（读取/写入 TS 层 SQLite）
│   │   └── DbClient              # fetchQueue/submitResult/submitBatch
│   ├── file_scanner.h            # 目录扫描 + TagLib 标签读取
│   │   └── FileScanner           # 递归扫描 + MBID/ISRC 检测
│   ├── scraper_engine.h          # 刮削引擎核心 + 异步结果提交器
│   │   ├── AsyncResultSubmitter  # 后台线程批量提交（背压 + 定时刷新）
│   │   └── ScraperEngine         # 两种模式：目录扫描 / DB 队列
│   └── tag_writer.h              # TagLib 标签写入器（ID3v2/Vorbis/MP4）
│       └── TagWriter             # 嵌入元数据、封面、歌词、MBID
└── src/
    └── main.cpp                  # CLI 入口（once / daemon / query）+ 信号处理
```

**刮削流程**：

```
本地文件
  └─ FileScanner.scanDirs() → 读取现有标签（含 MBID/ISRC 检测）
       └─ 跳过已刮削（有 MBID 或 ISRC 的文件）
            └─ MetadataResolver.resolve()
                 ├─ [并发] MusicBrainz → MBID + genre + composer + label + year + ISRC
                 ├─ [并发] Deezer → 元数据 + 封面 URL + 年份
                 ├─ [并发] iTunes → 元数据 + 封面 URL + 流派 + 年份
                 ├─ [并发] 网易云 [中文] → 标题 + 歌手 + 专辑 + 封面 + 歌词
                 ├─ [并发] QQ 音乐 [中文] → 同上
                 ├─ [并发] 酷狗 [中文] → 同上
                 ├─ [并发] 酷我 [中文] → 同上
                 ├─ [并发] 咪咕 [中文] → 同上
                 └─ 评分合并 → 最佳匹配结果
            └─ TagWriter.writeToFile() → 嵌入音频文件标签
            └─ AsyncResultSubmitter.submit() → [异步] 回写 SQLite
```

**安全特性**：
- 文件扫描：文件大小上限（默认 500MB）、扫描数量上限（50000）、连续失败上限（50）
- 信号处理：SIGTERM/SIGINT → `cancelFlag()` → 当前文件完成后 `drain()` → 安全退出
- 内存管理：`AsyncResultSubmitter` 队列深度 200（背压机制），提交后 `batch.clear()` 释放封面内存
- 降级策略：批量 `submitBatch` 失败 → 自动降级逐条 `submitResult`

### 2.5 C# 音乐扫描引擎（`scanner-cs/`）

状态：骨架阶段。
框架：.NET 9 + TagLibSharp。
功能：递归遍历目录 + TagLibSharp 元数据解析 + 通过 HTTP 代理写入 TS 层 SQLite。

```
scanner-cs/
├── Scanner.csproj
├── Program.cs                    # CLI 入口 + 信号处理
├── Scanner.cs                    # 递归目录遍历
├── MetadataExtractor.cs          # TagLibSharp 元数据解析
├── CoverWriter.cs                # 封面写入缓存
├── DatabaseWriter.cs             # HTTP 代理写入
├── Utils.cs                      # 文件 hash + 路径规范化
└── Models/
    └── TrackMetadata.cs          # 扫描结果模型
```

### 2.6 Go Subsonic 协议层（`subsonic-go/`）

状态：**已实现**。
框架：Go net/http + chi 路由 + modernc.org/sqlite。
功能：Subsonic REST 协议实现（~30 端点）。

```
subsonic-go/
├── main.go                       # HTTP 服务入口（:8081）
├── go.mod / go.sum
├── db/
│   └── sqlite.go                 # 只读 library.db + Subsonic 表读写
├── endpoints/
│   ├── system.go                 # ping / getLicense / getOpenSubsonicExtensions
│   ├── browsing.go               # getIndexes / getArtists / getAlbum / getAlbumList
│   ├── media.go                  # getSong / getRandomSongs / getCoverArt / stream
│   ├── lyrics.go                 # getLyrics / getLyricsBySongId
│   ├── playlists.go              # 歌单 CRUD
│   ├── starring.go               # 星标
│   ├── sharing.go                # 分享
│   └── users.go                  # 用户管理
├── middleware/
│   └── auth.go                   # token/salt 鉴权
├── model/
│   └── types.go                  # 数据模型
├── xmlutil/
│   ├── response.go               # XML 响应序列化
│   └── json.go                   # JSON 格式兼容
├── lyric/
│   └── lrc.go                    # LRC 解析
└── util/
    └── util.go                   # 工具函数
```

### 2.7 Rust 原生模块（`native/`）

#### audio-engine（napi-rs）
状态：已实现。提供音频解码、播放控制、均衡器、FFT、响度归一化。

```
native/audio-engine/
├── Cargo.toml
├── build.rs
├── package.json
├── index.d.ts
└── src/
    ├── lib.rs                     # napi-rs 入口
    ├── player.rs                  # 播放引擎
    ├── decoder.rs                 # 音频解码
    ├── source.rs                  # 音频源
    ├── http_source.rs             # HTTP 流式源
    ├── audio_output.rs            # 音频输出（cpal）
    ├── equalizer.rs               # 均衡器
    ├── fft.rs                     # FFT 频谱
    ├── loudness.rs                # 响度归一化（EBU R128）
    ├── tempo.rs                   # 变速不变调
    ├── metadata.rs                # 元数据读取
    ├── scanner.rs                 # 本地文件扫描
    ├── tag_editor.rs              # 标签编辑
    ├── error.rs                   # 错误类型
    ├── logger.rs                  # 日志
    └── shared.rs                  # 共享数据结构
```

#### download-engine（独立 CLI 二进制）
状态：已实现。reqwest + tokio 流式下载 + 进度上报。

```
native/download-engine/
├── Cargo.toml
└── src/
    ├── main.rs                    # CLI 入口（clap 参数解析）
    ├── downloader.rs              # reqwest 流式 → tokio::fs 落盘
    └── progress.rs                # stdout JSON lines 进度上报
```

#### media-ctrl（napi-rs）
状态：已实现。系统媒体键控制（Discord Rich Presence、系统媒体元数据）。

```
native/media-ctrl/
├── Cargo.toml
├── build.rs
├── package.json
├── index.d.ts
└── src/
    ├── lib.rs
    ├── discord.rs                 # Discord Rich Presence
    ├── sys_media/                 # 系统媒体控制
    │   ├── mod.rs
    │   ├── windows.rs
    │   ├── macos.rs
    │   └── linux.rs
    ├── model.rs                   # 数据模型
    └── logger.rs
```

#### taskbar-lyric（Windows napi-rs）
状态：已实现。Windows 任务栏歌词显示。

```
native/taskbar-lyric/
├── Cargo.toml
├── build.rs
├── package.json
├── index.d.ts
└── src/
    ├── lib.rs
    ├── uia.rs                     # UI Automation
    ├── uia_watcher.rs             # UIA 事件监听
    ├── tray_watcher.rs            # 托盘监控
    ├── taskbar_created_watcher.rs
    ├── registry_watcher.rs        # 注册表监控
    ├── service.rs                 # Windows 服务
    ├── strategy/                  # 渲染策略
    │   ├── mod.rs
    │   ├── win10.rs
    │   └── win11.rs
    └── utils.rs
```

#### taskbar-thumbnail（Windows napi-rs）
状态：已实现。Windows 任务栏缩略图工具栏。

```
native/taskbar-thumbnail/
├── Cargo.toml
├── build.rs
├── package.json
├── index.d.ts
└── src/
    └── lib.rs
```

### 2.8 共享模块（`shared/`）

前后端共享的 TypeScript 类型定义和工具函数。

```
shared/
├── types/
│   ├── player.ts                  # 播放器类型
│   ├── library.ts                 # 音乐库类型
│   ├── lyrics.ts                  # 歌词类型
│   ├── settings.ts                # 设置类型
│   ├── apis.ts
│   ├── download.ts
│   ├── streaming.ts
│   ├── tagEditor.ts
│   ├── plugin.ts
│   ├── platform.ts
│   ├── hotkey.ts
│   ├── stats.ts
│   ├── update.ts
│   ├── window.ts
│   ├── lastfm.ts
│   ├── cloudUpload.ts
│   ├── errors.ts
│   └── nowPlaying.ts
├── defaults/
│   ├── settings.ts                # 默认设置
│   ├── hotkeys.ts                 # 默认热键
│   └── plugin-api.ts              # 插件 API 定义
└── utils/
    ├── lyric.ts                   # 歌词工具
    ├── lyricSync.ts               # 歌词同步
    ├── path.ts                    # 路径工具
    └── accelerator.ts             # 快捷键加速器
```

### 2.9 独立窗口应用（`windows/`）

Vue 3 子应用，用于桌面歌词、Dynamic Island、任务栏歌词等独立窗口。

```
windows/
├── desktop-lyric/                 # 桌面歌词窗口
│   ├── index.html
│   ├── main.ts
│   ├── App.vue
│   ├── components/
│   ├── composables/
│   └── utils.ts
├── dynamic-island/                # Dynamic Island 窗口
│   ├── index.html
│   ├── main.ts
│   ├── App.vue
│   ├── components/
│   └── composables/
├── taskbar-lyric/                 # 任务栏歌词
│   ├── index.html
│   ├── main.ts
│   ├── App.vue
│   └── components/
└── shared/                        # 窗口共享 composables
    └── composables/
```

### 2.10 配置与脚本

```
electron/   # electron-builder 打包配置（electron-builder.yml 等）
docs/       # 文档与规划
scripts/    # 构建/部署脚本
```

---

## 三、进程通信架构

```
                    ┌──────────────────────────────────────────────┐
                    │            SPlayer 桌面应用                    │
                    │                                              │
  ┌──────────┐      │  ┌──────────────────────────────────────┐   │
  │ 系统托盘  │──────│─▶│         Electron 主进程                │   │
  │ 媒体键    │      │  │   src/main.ts → preload.ts            │   │
  └──────────┘      │  │   IPC 管理 / 窗口管理 / 原生菜单       │   │
                     │  └────────────┬─────────────────────────┘   │
                     │               │ IPC                         │
                     │  ┌────────────▼─────────────────────────┐   │
                     │  │       Vue 3 渲染进程（web/）           │   │
                     │  │   Vite + UnoCSS + Pinia + Reka UI    │   │
                     │  │   ↔ HTTP :8090 调用 TS API 层        │   │
                     │  └──────────────────────────────────────┘   │
                     │                                              │
                     │  ┌──────────────────────────────────────┐   │
                     │  │  TS API 层     server/ :8090         │   │
                     │  │  Hono + better-sqlite3               │   │
                     │  │                                      │   │
                     │  │  routes/:                            │   │
                     │  │    db.ts    ← SQLite 写入代理         │   │
                     │  │    scraper.ts                        │   │
                     │  │    download.ts                       │   │
                     │  │    ...                               │   │
                     │  │                                      │   │
                     │  │  apis/netease/   ← ⛔ 冻结            │   │
                     │  │  apis/qqmusic/   ← ⛔ 冻结            │   │
                     │  │  apis/kugou/     ← ⛔ 冻结            │   │
                     │  └──────┬───────────────────────────────┘   │
                     │         │ spawn + CLI args                 │
                     │         │ stdout JSON lines                 │
                     │         │                                  │
                     │  ┌──────▼───────────────────────────────┐   │
                     │  │  C++ 刮削器   scraper-cpp/           │   │
                     │  │  splayer-scraper                      │   │
                     │  │  once / daemon / query               │   │
                     │  │  stderr: [done N/Total] 进度         │   │
                     │  │  HTTP POST → /api/db/scrape/batch    │   │
                     │  └──────────────────────────────────────┘   │
                     │                                              │
                     │  ┌──────┬───────────────────────────────┐   │
                     │  │  C# 扫描器   scanner-cs/            │   │
                     │  │  splayer-scanner                     │   │
                     │  │  scan --dirs ...                     │   │
                     │  │  HTTP POST → /api/db/upsert          │   │
                     │  └──────────────────────────────────────┘   │
                     │                                              │
                     │  ┌──────┬───────────────────────────────┐   │
                     │  │  Rust 下载引擎  native/downloa...   │   │
                     │  │  splayer-downloader                  │   │
                     │  │  stdout: JSON progress lines         │   │
                     │  └──────────────────────────────────────┘   │
                     │                                              │
                     │  ┌──────┬───────────────────────────────┐   │
                     │  │  Subsonic Go   subsonic-go/ :8081    │   │
                     │  │  net/http + chi                     │   │
                     │  │  TS 反向代理 /rest/* → :8081         │   │
                     │  └──────────────────────────────────────┘   │
                     │                                              │
                     │  ┌──────────────────────────────────────┐   │
                     │  │  Rust Native  (napi-rs → .node)      │   │
                     │  │  audio-engine / media-ctrl           │   │
                     │  │  taskbar-lyric / taskbar-thumbnail   │   │
                     │  │  直接被 Electron 主进程加载           │   │
                     │  └──────────────────────────────────────┘   │
                     │                                              │
                     │  ┌──────────────────────────────────────┐   │
                     │  │  SQLite（library.db）  WAL 模式       │   │
                     │  │  /server/data/database/library.db    │   │
                     │  │  所有写入通过 /api/db/* 代理          │   │
                     │  └──────────────────────────────────────┘   │
                     └──────────────────────────────────────────────┘
```

---

## 四、SQLite 写入代理方案

**问题**：多进程直接写 SQLite 会导致 `SQLITE_BUSY` 冲突。

**解决方案**：所有写操作通过 TS 层 HTTP 接口代理，`better-sqlite3` 同步 API 天然串行。

**TS 层接口**（`server/routes/db.ts`）：

| 端点 | 方法 | 调用方 | 说明 |
|------|------|--------|------|
| `/api/db/upsert` | POST | C# Scanner | 批量插入/更新曲目 |
| `/api/db/delete` | POST | C# Scanner | 按路径批量删除 |
| `/api/db/upsert-tracks` | POST | C# Scanner | 增量扫描 upsert |
| `/api/db/scrape` | POST | C++ Scraper | 单条刮削结果写入 |
| `/api/db/scrape/batch` | POST | C++ Scraper | **批量**刮削结果写入（事务包裹） |
| `/api/db/scrape/queue` | GET/POST | C++ Scraper | 队列读取/更新 |
| `/api/db/tracks/:id` | GET | C++ Scraper | 获取单曲元数据 |
| `/api/db/scanner-status` | POST | C# Scanner | 记录扫描状态 |
| `/api/db/file-records` | GET | C# Scanner | 增量比对用文件记录 |
| `/api/db/download/progress` | POST | Rust Downloader | 更新下载进度 |
| `/api/db/download/status` | POST | Rust Downloader | 更新下载任务状态 |

---

## 五、多语言开发指南

### 5.1 语言隔离原则

| 组件 | 语言 | 与 TS 层通信方式 | 生命周期 |
|------|------|----------------|---------|
| 刮削器 | C++ | spawn + stderr 标记行 + HTTP POST | 每次刮削任务 spawn/daemon 常驻 |
| 扫描器 | C# | spawn + stdout JSON lines + HTTP POST | 每次扫描 spawn |
| 下载引擎 | Rust | spawn + stdout JSON lines | 每次下载 spawn |
| Subsonic | Go | 常驻 HTTP 服务，TS 反向代理 | 随容器启动 |
| Native 模块 | Rust | napi-rs 直接加载为 .node | 随 Electron 生命周期 |

### 5.2 SQLite 写入规范

- 所有写入通过 `POST /api/db/*` 代理
- 批量操作使用 `POST .../batch` 端点 + 服务端事务
- 读取可以直接走 Subsonic Go（只读 library.db）
- 禁止任何进程直接打开 library.db 写入

### 5.3 刮削器 C++ 依赖管理

- libcurl：系统包（`apt install libcurl4-openssl-dev`）或静态编译
- OpenSSL：系统包（`apt install libssl-dev`）或静态编译
- TagLib：系统包（`apt install libtag1-dev`）或源码编译
- nlohmann/json：header-only，已包含在 CMake 的 FetchContent 中

---

## 六、当前状态与 Roadmap

| 模块 | 状态 | 备注 |
|------|------|------|
| Vue 3 前端（`web/`） | ✅ 生产稳定 | Vite + UnoCSS + Pinia |
| Electron 主进程（`src/`） | ✅ 生产稳定 | IPC + 窗口管理 |
| TS 后端（`server/`） | ✅ 生产稳定 | Hono + better-sqlite3 |
| C++ 刮削器（`scraper-cpp/`） | ✅ 功能完整 | 多源并发 + 异步提交 + 背压 |
| Go Subsonic（`subsonic-go/`） | ✅ 已实现 | ~30 端点 |
| Rust audio-engine | ✅ 已实现 | napi-rs 播放引擎 |
| Rust download-engine | ✅ 已实现 | reqwest 流式下载 |
| Rust media-ctrl | ✅ 已实现 | 系统媒体控制 |
| Rust taskbar-lyric | ✅ 已实现 | Windows 任务栏歌词 |
| Rust taskbar-thumbnail | ✅ 已实现 | Windows 任务栏缩略图 |
| C# Scanner（`scanner-cs/`） | 🔧 骨架阶段 | TagLibSharp，待完善 |
| 歌词管道 | ✅ 生产稳定 | netease/qqmusic/kugou 聚合 |
| 在线 API 集成 | ✅ 生产稳定 | ⛔ 禁止重构 |
| Docker 多进程编排 | 📋 规划阶段 | |
| 端到端测试 | 📋 规划阶段 | 等待电源恢复后运行 |

---

> **关于重构 / 迁移**：
>
> 本文档中涉及的 C# Scanner 迁移、Go Subsonic 等，基于当前架构规划。
> 实际开发过程中，C++ 刮削器、Rust 原生模块、Go Subsonic 已分别在各自目录中
> 逐步实现和演进。当前多语言混合架构已在生产环境中运行。
