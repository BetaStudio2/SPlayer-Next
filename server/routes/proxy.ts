import { Hono } from "hono";
import { callNetease, clearNeteaseCookies, mergeNeteaseCookies } from "@main/apis/netease";
import { cookieToJson } from "@main/apis/netease/core/cookie";
import { callQQMusic } from "@main/apis/qqmusic";
import { callKugou } from "@main/apis/kugou";
import { coreLog } from "@main/utils/logger";
import type { ApiPlatform } from "@shared/types/apis";

const app = new Hono();

/** 各平台调用器：统一返回 { status?, body?, data? }，与桌面端 ipc:apis 一致 */
const dispatch = async (
  platform: ApiPlatform,
  name: string,
  params: Record<string, unknown>,
): Promise<Record<string, unknown>> => {
  switch (platform) {
    case "netease": {
      const res = await callNetease(name, params);
      return { status: res.status, body: res.body };
    }
    case "qqmusic": {
      const data = await callQQMusic(name, params);
      return { data };
    }
    case "kugou": {
      const data = await callKugou(name, params);
      return { data };
    }
    default:
      throw new Error(`unknown platform: ${platform}`);
  }
};

/**
 * 调用平台接口
 * POST /:platform/:name  body=params
 */
app.post("/:platform/:name", async (c) => {
  const platform = c.req.param("platform") as ApiPlatform;
  const name = c.req.param("name");
  const params = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  try {
    const result = await dispatch(platform, name, params);
    return c.json({ ok: true, ...result });
  } catch (err) {
    coreLog.warn(`[proxy] ${platform}.${name} failed:`, err);
    return c.json({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
});

/**
 * 清空某平台登录态
 * POST /:platform/session/clear
 */
app.post("/:platform/session/clear", (c) => {
  const platform = c.req.param("platform") as ApiPlatform;
  if (platform === "netease") clearNeteaseCookies();
  return c.json({ ok: true });
});

/**
 * 手动写入 cookie 登录（仅网易云）
 * POST /:platform/session/cookie  body={ raw: "MUSIC_U=xxx; ..." }
 */
app.post("/:platform/session/cookie", async (c) => {
  const platform = c.req.param("platform") as ApiPlatform;
  if (platform !== "netease") return c.json({ ok: false, error: "unsupported platform" });
  const { raw } = (await c.req.json().catch(() => ({}))) as { raw?: string };
  if (!raw) return c.json({ ok: false, error: "missing raw cookie" });
  const parsed = cookieToJson(raw);
  if (!parsed.MUSIC_U) return c.json({ ok: false, error: "missing MUSIC_U" });
  mergeNeteaseCookies(parsed);
  return c.json({ ok: true });
});

export default app;
