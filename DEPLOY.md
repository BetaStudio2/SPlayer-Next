# SPlayer-Next Web 部署指南

SPlayer-Next 的 Vue 3 前端可构建为纯 Web SPA，通过后端 `server/` 提供流媒体 + API 代理，单容器单端口部署。

## 目录结构

```
SPlayer-Next/
├── src/            # 原 Vue 前端（零修改）
├── shared/         # 跨进程类型（零修改）
├── public/         # 静态资源
├── server/         # P1 后端（Hono + SQLite + 流媒体引擎）
├── web/            # P3 Web 入口 + window.api Mock 层
├── Dockerfile      # 单容器多阶段构建
├── docker-compose.yml
├── nginx.conf      # 可选生产反代
└── .dockerignore
```

## 一、Docker 部署（推荐）

### 1. 准备数据目录

```bash
mkdir -p music data
# 把音乐文件放到 music/ 目录（支持 mp3/flac/ogg/m4a/wav 等）
```

### 2. 构建并启动

```bash
docker compose up -d --build
```

### 3. 访问

浏览器打开 `http://<服务器IP>:8080`，即同时获得 SPA + API。

### 4. 查看日志 / 停止

```bash
docker compose logs -f
docker compose down
```

### 数据目录结构

容器内挂载点：

| 宿主路径 | 容器路径 | 用途 |
|:--------|:--------|:----|
| `./music` | `/app/music` | 音乐库（只读挂载，server 扫描建索引） |
| `./data` | `/app/data` | SQLite 数据库 / 配置 / 封面缓存 / 下载缓存 |

## 二、原生运行（开发 / 调试）

需要 Node.js ≥ 22。

### 启动后端

```bash
cd server
npm install
npm run dev        # 开发模式（tsx watch，热重载）
# 或生产模式
npm run build && npm start
```

默认监听 `http://localhost:8080`。

### 启动前端（开发模式）

```bash
cd web
npm install
npm run dev        # vite dev，监听 http://localhost:14558
```

dev 模式下前端走 14558，`/api` 自动代理到 8080。

### 生产模式（单端口）

```bash
# 构建前端到 dist/web
cd web && npm run build

# 构建后端到 server/dist
cd ../server && npm run build

# 用 build 产物启动（SPA_DIR 指向前端产物）
SPA_DIR=../dist/web node dist/index.js
```

浏览器访问 `http://localhost:8080`，单端口同时提供 SPA + API。

## 三、环境变量

| 变量 | 默认值 | 说明 |
|:----|:------|:----|
| `PORT` | `8080` | 服务监听端口 |
| `SPA_DIR` | `process.cwd()/public` | 前端 SPA 静态目录，存在则启用 SPA serve |
| `MUSIC_DIR` | `server/data/music` | 音乐库扫描根目录 |
| `DATA_DIR` | `server/data` | 数据库 / 配置 / 缓存根目录 |
| `NETEASE_COOKIE` | - | 网易云 Cookie（可选，提升 API 代理能力） |
| `QQ_COOKIE` | - | QQ 音乐 Cookie |
| `KUGOU_COOKIE` | - | 酷狗 Cookie |

## 四、生产环境 Nginx 反代（可选）

单容器 Node 直 serve 已可生产使用。如需 SSL / 更强缓存 / 大并发，前置 Nginx：

```bash
# 用 nginx.conf 作为参考配置
sudo cp nginx.conf /etc/nginx/conf.d/splayer.conf
sudo nginx -t && sudo nginx -s reload
```

Nginx 配置要点：
- `/assets/*` 静态资源长期缓存（哈希文件名，immutable）
- `/` 与 `/api/*` 转发到 8080
- 音频流关闭 `proxy_buffering` 边播边传
- WebSocket 透传 `Upgrade` 头

## 五、架构说明

```
Browser (Vue 3 SPA)                  Server (Node.js Hono, :8080)
┌────────────────────┐              ┌──────────────────────────────┐
│  src/ (零修改)      │   HTTP      │  /api/music/*  流媒体引擎      │
│  调用 window.api.*  │ ─────────→  │  /api/proxy/*  在线 API 代理   │
│                    │              │  /api/lyric/*  歌词匹配        │
│  web/api Mock 层    │              │  /api/config/* 配置持久化      │
│  把 window.api 调用 │              │  /*            SPA 静态分发    │
│  转为 fetch 请求    │              │                              │
└────────────────────┘              │  SQLite (better-sqlite3)     │
                                    │  音频 Range serve             │
                                    │  封面 / 元信息提取            │
                                    └──────────────────────────────┘
```

`web/api/` Mock 层把原 `window.api.*` 调用转为 HTTP `fetch` 请求，前端 `src/` 代码零修改即可在浏览器运行。

## 六、已知限制

- **桌面专有功能降级**：桌面歌词 / 灵动岛 / 任务栏歌词 / 系统媒体控制 / Last.fm / 自动更新等在 Web 版以 stub 形式存在，调用返回安全默认值
- **本地文件访问**：浏览器无法直接访问用户本地文件，音乐文件需挂载到 server 通过 HTTP Range 流式播放
- **下载**：浏览器直存模式（`<a download>`），服务端缓存模式可后续扩展

## 七、开发模式联调

```bash
# 终端 1：后端
cd server && npm run dev

# 终端 2：前端
cd web && npm run dev
```

前端 14558 → `/api` 代理 → 后端 8080。修改 `src/` 或 `web/api/` 代码热重载。
