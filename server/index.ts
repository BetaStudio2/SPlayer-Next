import { Readable } from "node:stream";
import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import type { Server as HttpServer } from "node:http";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { initDatabase, closeDatabase } from "@main/database";
import { initLogger, serverLog } from "@main/utils/logger";
import { getAppCacheDir } from "@main/utils/config";
import { startMemoryManager, stopMemoryManager } from "@main/utils/memory";
import { startWatcher, stopWatcher } from "@main/music/watcher";
import { startMonitor, stopMonitor, patchConsole } from "./monitor/index";
import proxy from "./routes/proxy";
import music from "./routes/music";
import lyric from "./routes/lyric";
import config from "./routes/config";
import streaming from "./routes/streaming";
import download from "./routes/download";
import subsonic from "./routes/subsonic-proxy";
import subsonicAdmin from "./routes/subsonic-admin";
import subsonicInject from "./routes/subsonic-inject";
import dbProxy from "./routes/db";
import scraper from "./routes/scraper";
import comments from "./routes/comments";
import admin from "./routes/admin";
import { attachWebSocket } from "./routes/ws";

initLogger();
initDatabase();

const app = new Hono();

/** 健康检查 */
app.get("/api/health", (c) => c.json({ ok: true, ts: Date.now() }));

/** 在线音乐 API 代理 */
app.route("/api/proxy", proxy);
/** 本地曲库 */
app.route("/api/music", music);
/** 歌词匹配 */
app.route("/api/lyric", lyric);
/** 系统配置 */
app.route("/api/config", config);
/** 流媒体服务器凭据（加密存储） */
app.route("/api/streaming", streaming);
/** 下载任务（服务端落盘 + WS 进度推送） */
app.route("/api/download", download);
/** Subsonic API 服务端（/rest/*.view，供外部 Subsonic 客户端连接） */
app.route("/rest", subsonic);
/** Subsonic 服务管理（/api/subsonic/*，供 Web GUI 管理用户/分享） */
app.route("/api/subsonic", subsonicAdmin);
/** Subsonic 在线歌词注入（/api/subsonic-inject/*，供 Go 后端回调） */
app.route("/api/subsonic-inject", subsonicInject);
/** SQLite 写入代理（/api/db/*，供 C#/C++ 子进程统一写入） */
app.route("/api/db", dbProxy);
/** 音乐刮削（/api/scraper/*，供 Web GUI 启动/取消刮削） */
app.route("/api/scraper", scraper);
/** 歌曲评论（/api/comments/*，供 Web GUI 查看评论） */
app.route("/api/comments", comments);
/** 服务端监控仪表盘（/api/admin/*，代理 Go sidecar） */
app.route("/api/admin", admin);

/** /api/cache/* 静态：服务 musicbrainz 歌手头像等缓存文件 */
const CACHE_MIME: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  gif: "image/gif",
  svg: "image/svg+xml",
};
app.get("/api/cache/*", (c) => {
  const root = getAppCacheDir();
  const rel = decodeURIComponent(c.req.path.slice("/api/cache/".length));
  const resolved = path.resolve(root, rel);
  const rootWithSep = root.endsWith(path.sep) ? root : root + path.sep;
  if (resolved !== root && !resolved.startsWith(rootWithSep)) {
    return c.json({ error: "forbidden" }, 403);
  }
  if (!existsSync(resolved) || !statSync(resolved).isFile()) {
    return c.json({ error: "not found" }, 404);
  }
  const ext = path.extname(resolved).slice(1).toLowerCase();
  const mime = CACHE_MIME[ext] ?? "application/octet-stream";
  const stream = Readable.toWeb(createReadStream(resolved)) as ReadableStream;
  return new Response(stream, {
    headers: {
      "Content-Type": mime,
      "Cache-Control": "public, max-age=604800",
    },
  });
});

/**
 * SPA 静态文件分发
 * 生产环境 dist/web 存在时启用，dev 模式（前端走 vite 14558）不生效
 * 通过 SPA_DIR 环境变量指定静态目录，默认相对 server 运行位置的 public
 */
const SPA_DIR = path.resolve(process.env.SPA_DIR ?? path.join(process.cwd(), "public"));
const SPA_MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".wasm": "application/wasm",
};
if (existsSync(SPA_DIR) && statSync(SPA_DIR).isDirectory()) {
  app.get("/*", (c) => {
    const urlPath = decodeURIComponent(c.req.path);
    if (urlPath.startsWith("/api/")) return c.notFound();
    const resolved = path.resolve(SPA_DIR, urlPath.slice(1) || "index.html");
    const rootWithSep = SPA_DIR.endsWith(path.sep) ? SPA_DIR : SPA_DIR + path.sep;
    if (resolved !== SPA_DIR && !resolved.startsWith(rootWithSep)) {
      return c.json({ error: "forbidden" }, 403);
    }
    if (existsSync(resolved) && statSync(resolved).isFile()) {
      const ext = path.extname(resolved).toLowerCase();
      const mime = SPA_MIME[ext] ?? "application/octet-stream";
      const stream = Readable.toWeb(createReadStream(resolved)) as ReadableStream;
      return new Response(stream, {
        headers: {
          "Content-Type": mime,
          "Cache-Control":
            ext === ".html" ? "no-cache" : "public, max-age=31536000, immutable",
        },
      });
    }
    const index = path.join(SPA_DIR, "index.html");
    if (existsSync(index)) {
      return c.html(readFileSync(index, "utf-8"));
    }
    return c.notFound();
  });
  serverLog.info(`[spa] serving static from ${SPA_DIR}`);
}

const PORT = Number(process.env.PORT ?? 8080);
const httpServer = serve({ fetch: app.fetch, port: PORT }, (info) => {
  serverLog.info(`[server] listening on http://localhost:${info.port}`);
  startMemoryManager();
  startWatcher();
  startMonitor();
  patchConsole();
});
// 挂载 WebSocket 到同一 HTTP server（路径 /ws）
// serve() 返回类型为 ServerType（含 Http2Server 联合），运行时为 http.Server
attachWebSocket(httpServer as unknown as HttpServer);

const shutdown = (): void => {
  stopMemoryManager();
  void stopWatcher();
  stopMonitor();
  closeDatabase();
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", () => {
  shutdown();
  process.exit(0);
});
