/**
 * window.api.apis mock：在线音源代理
 * 转发到 server /api/proxy/{platform}/{name}
 */
import type { ApisApi, ApiPlatform, ApiCallResponse } from "@shared/types/apis";

const json = async (res: Response): Promise<ApiCallResponse> => {
  if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
  const body = (await res.json()) as { ok?: boolean; status?: number; body?: unknown; data?: unknown; error?: string };
  if (body.ok) return { ok: true, status: body.status, body: body.body, data: body.data };
  return { ok: false, error: body.error ?? "unknown" };
};

export const apisApi: ApisApi = {
  async call(
    platform: ApiPlatform,
    name: string,
    params: Record<string, unknown> = {},
  ): Promise<ApiCallResponse> {
    try {
      const res = await fetch(`/api/proxy/${platform}/${name}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(params),
      });
      return await json(res);
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : "network error" };
    }
  },

  async clearSession(platform: ApiPlatform): Promise<void> {
    await fetch(`/api/proxy/${platform}/session/clear`, { method: "POST" });
  },

  async openLoginWeb(): Promise<{ ok: true } | { ok: false; error: string }> {
    // Web 版无内嵌登录窗口，引导用户用 setCookie 手动登录
    return { ok: false, error: "Web 版请使用 Cookie 方式登录" };
  },

  async setCookie(
    platform: ApiPlatform,
    cookie: string,
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    try {
      const res = await fetch(`/api/proxy/${platform}/session/cookie`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ raw: cookie }),
      });
      const body = (await res.json()) as { ok: boolean; error?: string };
      return body.ok ? { ok: true } : { ok: false, error: body.error ?? "failed" };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : "network error" };
    }
  },
};
