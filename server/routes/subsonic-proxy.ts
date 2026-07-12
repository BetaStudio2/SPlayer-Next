/**
 * Subsonic 反向代理
 *
 * 所有 /rest/* 请求反向代理到 Go Subsonic 服务。
 * Go 默认不启动，需要通过管理面板手动启动，或设置 SPLAYER_SUBSONIC_BACKEND_URL 环境变量。
 * 未配置或 Go 不可达时返回 503。
 */
import { Hono, type Context } from "hono";
import { serverLog } from "@main/utils/logger";

const app = new Hono();

const BACKEND_URL = process.env.SPLAYER_SUBSONIC_BACKEND_URL ?? "http://127.0.0.1:8081";

if (BACKEND_URL) {
  serverLog.info(`[subsonic-proxy] → Go backend: ${BACKEND_URL}（默认不自动启动，需管理面板手动启动）`);
}

/** 透传到 Go Subsonic */
const proxyToGo = async (c: Context): Promise<Response> => {
  const targetUrl = `${BACKEND_URL.replace(/\/+$/, "")}${c.req.url.slice(c.req.url.indexOf("/rest/"))}`;
  serverLog.info(`[subsonic-proxy] → Go: ${c.req.method} ${targetUrl.slice(0, 150)}`);

  const headers: Record<string, string> = {
    "user-agent": c.req.header("user-agent") ?? "splayer-proxy",
  };
  for (const h of ["content-type", "range", "if-none-match", "if-modified-since"]) {
    const v = c.req.header(h);
    if (v) headers[h] = v;
  }

  const init: RequestInit = { method: c.req.method, headers };

  if (c.req.method === "POST" || c.req.method === "PUT") {
    const body = await c.req.arrayBuffer();
    if (body.byteLength > 0) init.body = body;
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 5_000);
  let resp: Response;
  try {
    resp = await fetch(targetUrl, { ...init, signal: ctrl.signal });
  } catch {
    clearTimeout(timer);
    return subsonicUnavailable(c);
  } finally {
    clearTimeout(timer);
  }

  serverLog.info(`[subsonic-proxy] Go ←: ${resp.status} ${resp.headers.get("content-type") ?? "-"}`);

  const respHeaders = new Headers();
  for (const h of [
    "content-type", "content-length", "content-range",
    "accept-ranges", "cache-control", "content-disposition", "etag", "last-modified",
  ]) {
    const v = resp.headers.get(h);
    if (v) respHeaders.set(h, v);
  }

  return new Response(resp.body, {
    status: resp.status,
    statusText: resp.statusText,
    headers: respHeaders,
  });
};

/** Subsonic 协议格式的 503 响应 */
const subsonicUnavailable = (c: Context): Response => {
  return c.json(
    {
      "subsonic-response": {
        status: "failed",
        version: "1.16.1",
        error: { code: 50, message: "Go backend 未运行，请在 Subsonic 管理面板中启动" },
      },
    },
    503,
  );
};

/** 所有 /rest/* → Go（不可达时返回 503） */
app.all("/*", async (c) => {
  serverLog.info(`[subsonic-proxy] ${c.req.method} ${c.req.path.slice(0, 80)}`);
  return proxyToGo(c);
});

export default app;
