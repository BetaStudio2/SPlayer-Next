/**
 * 管理监控 API — 代理 Go sidecar
 *
 * GET /api/admin/stats   系统资源统计（CPU / 内存 / 进程）
 * GET /api/admin/logs    最近日志（?tail=N）
 * GET /api/admin/health  健康检查
 *
 * 当 sidecar 未运行时，所有端点返回 503。
 */
import { Hono } from "hono";
import { getAdminBase, isMonitorRunning } from "../monitor/index";

const router = new Hono();
const TIMEOUT_MS = 5_000;

async function proxyToSidecar(c: any, path: string): Promise<Response> {
  if (!isMonitorRunning()) {
    return c.json({ error: "monitor not available" }, 503);
  }

  const url = `${getAdminBase()}${path}${c.req.url.includes("?") ? "?" + c.req.url.split("?")[1] : ""}`;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);

    if (!res.ok) {
      return c.json({ error: `sidecar error: ${res.status}` }, res.status as any);
    }
    const data = await res.json();
    return c.json(data);
  } catch (err: any) {
    return c.json({ error: err.name === "AbortError" ? "timeout" : err.message }, 502);
  }
}

router.get("/stats", async (c) => proxyToSidecar(c, "/stats"));
router.get("/logs", async (c) => proxyToSidecar(c, "/logs"));
router.get("/health", async (c) => proxyToSidecar(c, "/health"));

/**
 * SSE 流式代理：将 Go sidecar 的 /stream（SSE）透传给前端
 * 前端通过 EventSource 消费，获得实时 stats + logs 推送。
 */
router.get("/stream", async (c) => {
  if (!isMonitorRunning()) {
    return c.json({ error: "monitor not available" }, 503);
  }

  const url = `${getAdminBase()}/stream`;
  const controller = new AbortController();

  try {
    const res = await fetch(url, { signal: controller.signal });

    if (!res.ok) {
      return c.json({ error: `sidecar error: ${res.status}` }, res.status as any);
    }

    // 客户端断开时中止与 sidecar 的连接
    c.req.raw.signal.addEventListener("abort", () => controller.abort());

    // 将 sidecar 的 SSE 流直接 pipe 给前端
    return new Response(res.body as ReadableStream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    });
  } catch (err: any) {
    return c.json({ error: err.name === "AbortError" ? "timeout" : err.message }, 502);
  }
});

export default router;
