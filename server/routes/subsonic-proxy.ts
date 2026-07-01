/**
 * Subsonic 反向代理
 *
 * 多语言架构中，Subsonic 协议层由独立的 Go 服务（subsonic-go）实现。
 * TS 层将 /rest/* 请求反向代理到 Go 服务，外部客户端无感知。
 *
 * 降级策略：
 *   - 配置了 SUBSONIC_BACKEND_URL → 反向代理到 Go Subsonic
 *   - 未配置或 Go 不可达 → 降级到 TS 原生实现（routes/subsonic.ts）
 *
 * 这样开发环境（未启动 Go）仍可使用 TS 实现，生产环境（docker-compose）走 Go。
 */
import { Hono, type Context } from "hono";
import { serverLog } from "@main/utils/logger";
import tsSubsonic from "./subsonic";

const app = new Hono();

const BACKEND_URL = process.env.SUBSONIC_BACKEND_URL ?? "";

// #region debug-point proxy-entry
serverLog.info(`[subsonic-proxy] 启动: BACKEND_URL=${BACKEND_URL || "(empty → 走 TS 回退)"}`);
// #endregion

/** Go 后端是否可用（启动时探测一次，失败后降级到 TS） */
let backendAvailable = false;
let probePromise: Promise<boolean> | null = null;

/** 探测 Go 后端是否可达（通过 /rest/ping.view） */
const probeBackend = async (): Promise<boolean> => {
  if (!BACKEND_URL) return false;
  try {
    const url = `${BACKEND_URL}/rest/ping.view?u=probe&p=probe&v=1.16.1&c=splayer-probe&f=json`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 2000);
    const resp = await fetch(url, { signal: ctrl.signal });
    clearTimeout(timer);
    backendAvailable = resp.ok || resp.status === 200;
    if (backendAvailable) {
      serverLog.info(`[subsonic-proxy] Go 后端可用: ${BACKEND_URL}`);
    } else {
      serverLog.warn(`[subsonic-proxy] Go 后端响应异常: ${resp.status}，降级到 TS 实现`);
    }
    return backendAvailable;
  } catch (err) {
    serverLog.warn(
      `[subsonic-proxy] Go 后端不可达: ${err instanceof Error ? err.message : "unknown"}，降级到 TS 实现`,
    );
    backendAvailable = false;
    return false;
  }
};

/** 单次探测（并发请求复用同一个 Promise） */
const ensureProbed = (): Promise<boolean> => {
  if (!probePromise) {
    probePromise = probeBackend().finally(() => {
      // 5 秒后允许重新探测（Go 可能稍后启动）
      setTimeout(() => {
        probePromise = null;
      }, 5000);
    });
  }
  return probePromise;
};

/** 反向代理到 Go Subsonic */
const proxyToGo = async (c: Context): Promise<Response> => {
  const url = new URL(c.req.url);
  const targetUrl = `${BACKEND_URL}${url.pathname}${url.search}`;

  // #region debug-point proxy-to-go
  serverLog.info(`[subsonic-proxy] → Go: ${c.req.method} ${targetUrl.slice(0, 150)}`);
  // #endregion

  // 透传请求方法和 body
  const init: RequestInit = {
    method: c.req.method,
    headers: {
      // 透传原始请求头（保留 Subsonic 认证参数）
      "user-agent": c.req.header("user-agent") ?? "splayer-proxy",
      ...(c.req.header("content-type") ? { "content-type": c.req.header("content-type")! } : {}),
      // 转发 Range 请求头（流式传输必需）
      ...(c.req.header("range") ? { range: c.req.header("range")! } : {}),
      ...(c.req.header("if-none-match") ? { "if-none-match": c.req.header("if-none-match")! } : {}),
      ...(c.req.header("if-modified-since")
        ? { "if-modified-since": c.req.header("if-modified-since")! }
        : {}),
    },
  };

  // 转发请求体（POST/PUT）
  if (c.req.method === "POST" || c.req.method === "PUT") {
    const body = await c.req.arrayBuffer();
    if (body.byteLength > 0) {
      init.body = body;
    }
  }

  const resp = await fetch(targetUrl, init);

  // #region debug-point proxy-response
  serverLog.info(`[subsonic-proxy] Go ←: ${resp.status} ${resp.headers.get("content-type") ?? "-"}`);
  // #endregion

  // 透传响应头
  const respHeaders = new Headers();
  const passthrough = [
    "content-type",
    "content-length",
    "content-range",
    "accept-ranges",
    "cache-control",
    "content-disposition",
    "etag",
    "last-modified",
  ];
  for (const h of passthrough) {
    const v = resp.headers.get(h);
    if (v) respHeaders.set(h, v);
  }

  return new Response(resp.body, {
    status: resp.status,
    statusText: resp.statusText,
    headers: respHeaders,
  });
};

/** 统一入口：先探测 Go，可用则代理，否则降级到 TS */
app.all("/*", async (c) => {
  // #region debug-point dispatch-entry
  serverLog.info(`[subsonic-proxy] 收到: ${c.req.method} ${c.req.path.slice(0, 80)}`);
  // #endregion

  // 未配置后端 → 直接走 TS 实现
  if (!BACKEND_URL) {
    // #region debug-point fallback-no-backend
    serverLog.info(`[subsonic-proxy] 无 BACKEND_URL，回退到 TS subsonic`);
    // #endregion
    return tsSubsonic.fetch(new Request(c.req.raw.url, c.req.raw), c.env);
  }

  // 已确认后端可用 → 直接代理
  if (backendAvailable) {
    return proxyToGo(c);
  }

  // 探测后端
  const ok = await ensureProbed();
  if (ok) {
    return proxyToGo(c);
  }

  // 降级到 TS 实现
  // #region debug-point fallback-after-probe
  serverLog.info(`[subsonic-proxy] probe 失败，回退到 TS subsonic (rawUrl: ${c.req.raw.url.slice(0, 100)})`);
  // #endregion
  return tsSubsonic.fetch(new Request(c.req.raw.url, c.req.raw), c.env);
});

export default app;
