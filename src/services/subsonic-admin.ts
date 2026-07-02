/**
 * Subsonic 服务管理 API client
 *
 * 直接调用服务端 /api/subsonic/* 管理接口（用户/分享/状态/登录）。
 * 仅在 web 服务端模式下使用，不走 IPC。
 * 会话基于 HttpOnly cookie，浏览器自动携带，无需手动管理 token。
 */

export interface SubsonicServiceStatus {
  enabled: boolean;
  /** 服务器根地址（填入 Subsonic 客户端"服务器地址"字段） */
  endpoint: string;
  /** 完整 REST 端点地址（含 /rest 后缀，兼容部分客户端） */
  restEndpoint?: string;
  apiVersion: string;
  serverType: string;
  initialized: boolean;
  userCount: number;
  adminExists: boolean;
  /** Go 后端运行状态 */
  goBackend: { running: boolean; pid: number | null; startTime: number };
}

export interface SubsonicServiceUser {
  id: string;
  username: string;
  isAdmin: boolean;
  createdAt: number;
}

export interface SubsonicServiceShare {
  id: string;
  name: string;
  url: string;
  description: string | null;
  owner: string;
  createdAt: number;
  expiresAt: number | null;
  visitCount: number;
  trackCount: number;
}

export interface SubsonicServiceSession {
  loggedIn: boolean;
  username?: string;
  isAdmin?: boolean;
}

const json = async <T>(res: Response): Promise<T> => {
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `HTTP ${res.status}`);
  }
  const body = (await res.json()) as { success: boolean; data?: T; error?: string };
  if (!body.success) throw new Error(body.error ?? "request failed");
  return body.data as T;
};

export const subsonicAdminApi = {
  async getStatus(): Promise<SubsonicServiceStatus> {
    return json(await fetch("/api/subsonic/status"));
  },
  async getSession(): Promise<SubsonicServiceSession> {
    return json(await fetch("/api/subsonic/session"));
  },
  async setup(input: { username: string; password: string }): Promise<{ id: string; username: string; isAdmin: boolean }> {
    return json(
      await fetch("/api/subsonic/setup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
        credentials: "same-origin",
      }),
    );
  },
  async login(input: { username: string; password: string }): Promise<{ id: string; username: string; isAdmin: boolean }> {
    return json(
      await fetch("/api/subsonic/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
        credentials: "same-origin",
      }),
    );
  },
  async logout(): Promise<void> {
    await json(await fetch("/api/subsonic/logout", { method: "POST", credentials: "same-origin" }));
  },
  async listUsers(): Promise<SubsonicServiceUser[]> {
    return json(await fetch("/api/subsonic/users", { credentials: "same-origin" }));
  },
  async createUser(input: { username: string; password: string; isAdmin?: boolean }): Promise<SubsonicServiceUser> {
    return json(
      await fetch("/api/subsonic/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
        credentials: "same-origin",
      }),
    );
  },
  async updateUser(id: string, input: { password?: string; isAdmin?: boolean }): Promise<void> {
    await json(
      await fetch(`/api/subsonic/users/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
        credentials: "same-origin",
      }),
    );
  },
  async deleteUser(id: string): Promise<void> {
    await json(await fetch(`/api/subsonic/users/${id}`, { method: "DELETE", credentials: "same-origin" }));
  },
  async listShares(): Promise<SubsonicServiceShare[]> {
    return json(await fetch("/api/subsonic/shares", { credentials: "same-origin" }));
  },
  async deleteShare(id: string): Promise<void> {
    await json(await fetch(`/api/subsonic/shares/${id}`, { method: "DELETE", credentials: "same-origin" }));
  },

  /* ---- Go 后端管理 ---- */

  async getGoStatus(): Promise<{ running: boolean; pid: number | null; startTime: number }> {
    return json(await fetch("/api/subsonic/go/status", { credentials: "same-origin" }));
  },
  async startGoBackend(): Promise<{ running: boolean; pid: number | null; startTime: number }> {
    return json(
      await fetch("/api/subsonic/go/start", { method: "POST", credentials: "same-origin" }),
    );
  },
  async stopGoBackend(): Promise<{ running: boolean; pid: number | null; startTime: number }> {
    return json(
      await fetch("/api/subsonic/go/stop", { method: "POST", credentials: "same-origin" }),
    );
  },
};
