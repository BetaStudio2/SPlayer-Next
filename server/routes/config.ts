import { existsSync, mkdirSync, unlinkSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { Hono } from "hono";
import { store } from "@main/store";
import { getBackgroundsDir } from "@main/utils/config";
import { toCacheUrl } from "@main/utils/protocol";
import { libraryLog, serverLog } from "@main/utils/logger";
import { testNetworkProxy } from "@main/utils/proxy";

const app = new Hono();

/** GET / —— 全量配置 */
app.get("/", (c) => c.json(store.store));

/** GET /:keyPath —— 按 dot path 取值（如 library.scanDirs） */
app.get("/:keyPath", (c) => c.json(store.get(c.req.param("keyPath") as never)));

/** PUT /:keyPath —— 按 dot path 写值，body 为原始值 */
app.put("/:keyPath", async (c) => {
  const keyPath = c.req.param("keyPath");
  const value = await c.req.json().catch(() => undefined);
  store.set(keyPath as never, value);
  return c.json({ success: true });
});

/** POST /replace —— 用整盘配置替换当前 */
app.post("/replace", async (c) => {
  const payload = await c.req.json().catch(() => ({}));
  store.replaceAll(payload);
  return c.json({ success: true });
});

/** POST /reset —— 重置为默认配置 */
app.post("/reset", (c) => {
  store.clear();
  return c.json({ success: true });
});

/** POST /testProxy —— 测试网络代理连通性 */
app.post("/testProxy", async (c) => {
  const ok = await testNetworkProxy();
  if (!ok) serverLog.warn("[config] proxy test failed");
  return c.json({ ok });
});

/* ------------------------------------------------------------------ */
/* 背景图片管理                                                        */
/* ------------------------------------------------------------------ */
const MAX_BG_SIZE = 30 * 1024 * 1024;

/**
 * POST /background —— 上传背景图片
 *
 * body 为原始图片二进制，Content-Type 指定图片类型。
 * 响应：{ url: "/api/cache/backgrounds/<sha1>.ext" }
 */
app.post("/background", async (c) => {
  try {
    const contentType = c.req.header("content-type") ?? "image/jpeg";
    // 从 Content-Type 推断扩展名
    const extMap: Record<string, string> = {
      "image/jpeg": ".jpg",
      "image/jpg": ".jpg",
      "image/png": ".png",
      "image/webp": ".webp",
      "image/bmp": ".bmp",
      "image/gif": ".gif",
    };
    const ext = extMap[contentType] ?? ".jpg";

    const arrayBuffer = await c.req.raw.arrayBuffer();
    if (!arrayBuffer || arrayBuffer.byteLength === 0) {
      return c.json({ error: "empty body" }, 400);
    }
    if (arrayBuffer.byteLength > MAX_BG_SIZE) {
      return c.json({ error: `file too large: ${arrayBuffer.byteLength} > ${MAX_BG_SIZE}` }, 413);
    }

    const data = Buffer.from(arrayBuffer);
    const hash = createHash("sha1").update(data).digest("hex").slice(0, 16);
    const bgDir = getBackgroundsDir();

    // 清空旧背景图，保留新图
    if (existsSync(bgDir)) {
      const oldFiles = await import("node:fs/promises").then((m) => m.readdir(bgDir));
      for (const f of oldFiles) {
        try { unlinkSync(path.join(bgDir, f)); } catch { /* ignore */ }
      }
    }
    mkdirSync(bgDir, { recursive: true });

    const dest = path.join(bgDir, `${hash}${ext}`);
    await import("node:fs/promises").then((m) => m.writeFile(dest, data));

    const url = toCacheUrl(dest);
    libraryLog.info(`[config] background saved: ${url}`);
    return c.json({ url });
  } catch (err) {
    libraryLog.error("[config] upload background failed:", err);
    return c.json({ error: err instanceof Error ? err.message : "unknown error" }, 500);
  }
});

/**
 * DELETE /background —— 清空所有背景图
 */
app.delete("/background", async (c) => {
  try {
    const bgDir = getBackgroundsDir();
    if (existsSync(bgDir)) {
      const oldFiles = await import("node:fs/promises").then((m) => m.readdir(bgDir));
      for (const f of oldFiles) {
        try { unlinkSync(path.join(bgDir, f)); } catch { /* ignore */ }
      }
    }
    return c.json({ success: true });
  } catch (err) {
    libraryLog.error("[config] clear backgrounds failed:", err);
    return c.json({ error: err instanceof Error ? err.message : "unknown error" }, 500);
  }
});

export default app;
