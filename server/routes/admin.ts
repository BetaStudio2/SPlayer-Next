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

export default router;
