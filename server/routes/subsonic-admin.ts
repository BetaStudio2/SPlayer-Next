/**
 * Subsonic 服务管理 API（供 SPlayer Web GUI 调用）
 *
 * 与 /rest/* 的 Subsonic 协议端点不同，这组 API 用于管理 SPlayer 自身作为
 * 流媒体服务器的配置：用户增删、分享管理、服务状态查询。
 *
 * 路由挂载于 /api/subsonic/*。
 *
 * 认证：
 *   - /api/subsonic/status      公开（仅返回是否已初始化等非敏感信息）
 *   - /api/subsonic/setup       仅在无管理员时可调用，创建首个 admin
 *   - /api/subsonic/login       公开，返回会话 token（HttpOnly cookie）
 *   - /api/subsonic/logout      清除会话
 *   - 其余（users/shares 增删改）需管理员会话
 *
 * 会话：内存 Map（sid → { userId, expiresAt }），cookie 名 splayer_admin，
 * 单进程重启失效（重新登录即可，无强持久化需求）。
 */
import { Hono, type Context, type MiddlewareHandler } from "hono";
import {
  listUsers,
  createUser,
  updateUser,
  deleteUser,
  listShares,
  deleteShare,
  getUserByUsername,
  type SubsonicUser,
} from "@main/database/subsonic";
import { randomUUID } from "node:crypto";

const app = new Hono();

const ok = <T>(data: T) => ({ success: true as const, data });
const fail = (error: string) => ({ success: false as const, error });

const COOKIE_NAME = "splayer_admin";
const SESSION_TTL = 1000 * 60 * 60 * 12; // 12h

/** 内存会话表：sid → 用户信息 + 过期时间 */
const sessions = new Map<string, { user: SubsonicUser; expiresAt: number }>();

const cleanupExpired = (): void => {
  const now = Date.now();
  for (const [sid, s] of sessions) {
    if (s.expiresAt < now) sessions.delete(sid);
  }
};

/** 从请求 cookie 中解析 sid */
const getSidFromReq = (c: Context): string | null => {
  const cookie = c.req.header("cookie") ?? "";
  for (const part of cookie.split(";")) {
    const [k, v] = part.trim().split("=");
    if (k === COOKIE_NAME && v) return v;
  }
  return null;
};

/** 鉴权中间件：要求登录的管理员 */
const requireAdmin: MiddlewareHandler = async (c, next) => {
  cleanupExpired();
  const sid = getSidFromReq(c);
  if (!sid) return c.json(fail("unauthorized"), 401);
  const session = sessions.get(sid);
  if (!session || session.expiresAt < Date.now()) {
    sessions.delete(sid);
    return c.json(fail("unauthorized"), 401);
  }
  if (!session.user.isAdmin) return c.json(fail("forbidden: admin only"), 403);
  c.set("adminUser", session.user);
  await next();
};

/* ------------------------------------------------------------------ */
/* 公开端点                                                            */
/* ------------------------------------------------------------------ */

/** GET /status —— 服务状态（端点、版本、是否已初始化） */
app.get("/status", (c) => {
  const users = listUsers();
  const host = c.req.header("host") ?? "localhost";
  const proto = c.req.header("x-forwarded-proto") ?? (c.req.url.startsWith("https") ? "https" : "http");
  const adminExists = users.some((u) => u.isAdmin);
  const baseUrl = `${proto}://${host}`;
  return c.json(
    ok({
      enabled: true,
      // 服务器根地址：填入 Subsonic 客户端"服务器地址"字段
      // 客户端会自动追加 /rest/<endpoint>，服务端同时兼容双重 /rest 前缀
      endpoint: baseUrl,
      restEndpoint: `${baseUrl}/rest`,
      apiVersion: "1.16.1",
      serverType: "subsonic",
      initialized: adminExists,
      userCount: users.length,
      adminExists,
    }),
  );
});

/** POST /setup —— 首次初始化（仅当不存在任何管理员时可用） */
app.post("/setup", async (c) => {
  const hasAdmin = listUsers().some((u) => u.isAdmin);
  if (hasAdmin) return c.json(fail("already initialized"), 403);
  const body = (await c.req.json().catch(() => null)) as {
    username?: string;
    password?: string;
  } | null;
  if (!body?.username || !body?.password) return c.json(fail("missing username/password"), 400);
  if (body.password.length < 6) return c.json(fail("password too short (>=6)"), 400);
  try {
    const user = createUser({
      username: body.username,
      password: body.password,
      isAdmin: true,
    });
    // 初始化后自动登录
    const sid = randomUUID();
    sessions.set(sid, { user, expiresAt: Date.now() + SESSION_TTL });
    c.header("set-cookie", `${COOKIE_NAME}=${sid}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_TTL / 1000}`);
    return c.json(ok({ id: user.id, username: user.username, isAdmin: true }));
  } catch (err) {
    return c.json(fail(err instanceof Error ? err.message : "setup failed"), 400);
  }
});

/** POST /login —— 管理员登录 */
app.post("/login", async (c) => {
  const body = (await c.req.json().catch(() => null)) as {
    username?: string;
    password?: string;
  } | null;
  if (!body?.username || !body?.password) return c.json(fail("missing username/password"), 400);
  const user = getUserByUsername(body.username);
  if (!user || user.password !== body.password || !user.isAdmin) {
    return c.json(fail("invalid credentials"), 401);
  }
  const sid = randomUUID();
  sessions.set(sid, { user, expiresAt: Date.now() + SESSION_TTL });
  c.header("set-cookie", `${COOKIE_NAME}=${sid}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_TTL / 1000}`);
  return c.json(ok({ id: user.id, username: user.username, isAdmin: true }));
});

/** POST /logout —— 注销当前会话 */
app.post("/logout", (c) => {
  const sid = getSidFromReq(c);
  if (sid) sessions.delete(sid);
  c.header("set-cookie", `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`);
  return c.json(ok({ loggedOut: true }));
});

/** GET /session —— 查询当前会话（前端刷新页面后判断是否仍登录） */
app.get("/session", (c) => {
  cleanupExpired();
  const sid = getSidFromReq(c);
  if (!sid) return c.json(ok({ loggedIn: false }));
  const session = sessions.get(sid);
  if (!session || session.expiresAt < Date.now()) {
    sessions.delete(sid);
    return c.json(ok({ loggedIn: false }));
  }
  return c.json(
    ok({
      loggedIn: true,
      username: session.user.username,
      isAdmin: session.user.isAdmin,
    }),
  );
});

/* ------------------------------------------------------------------ */
/* 以下需管理员会话                                                     */
/* ------------------------------------------------------------------ */

app.get("/users", requireAdmin, (c) => {
  const users = listUsers().map((u) => ({
    id: u.id,
    username: u.username,
    isAdmin: u.isAdmin,
    createdAt: u.createdAt,
  }));
  return c.json(ok(users));
});

app.post("/users", requireAdmin, async (c) => {
  const body = (await c.req.json().catch(() => null)) as {
    username?: string;
    password?: string;
    isAdmin?: boolean;
  } | null;
  if (!body?.username || !body?.password) return c.json(fail("missing username/password"), 400);
  if (body.password.length < 6) return c.json(fail("password too short (>=6)"), 400);
  try {
    const user = createUser({
      username: body.username,
      password: body.password,
      isAdmin: body.isAdmin ?? false,
    });
    return c.json(ok({ id: user.id, username: user.username, isAdmin: user.isAdmin, createdAt: user.createdAt }));
  } catch (err) {
    return c.json(fail(err instanceof Error ? err.message : "create failed"), 400);
  }
});

app.put("/users/:id", requireAdmin, async (c) => {
  const id = c.req.param("id");
  const body = (await c.req.json().catch(() => ({}))) as {
    password?: string;
    isAdmin?: boolean;
  };
  if (body.password != null && body.password !== "" && body.password.length < 6) {
    return c.json(fail("password too short (>=6)"), 400);
  }
  try {
    updateUser(id, { password: body.password, isAdmin: body.isAdmin });
    return c.json(ok({ updated: true }));
  } catch (err) {
    return c.json(fail(err instanceof Error ? err.message : "update failed"), 400);
  }
});

app.delete("/users/:id", requireAdmin, (c) => {
  const id = c.req.param("id");
  try {
    deleteUser(id);
    return c.json(ok({ deleted: true }));
  } catch (err) {
    return c.json(fail(err instanceof Error ? err.message : "delete failed"), 400);
  }
});

app.get("/shares", requireAdmin, (c) => {
  const users = listUsers();
  const all = users.flatMap((u) =>
    listShares(u.id).map((s) => ({
      id: s.id,
      name: s.name,
      url: s.url,
      description: s.description,
      owner: u.username,
      createdAt: s.createdAt,
      expiresAt: s.expiresAt,
      visitCount: s.visitCount,
      trackCount: s.trackIds.length,
    })),
  );
  return c.json(ok(all));
});

app.delete("/shares/:id", requireAdmin, (c) => {
  const id = c.req.param("id");
  const users = listUsers();
  for (const u of users) {
    deleteShare(id, u.id);
  }
  return c.json(ok({ deleted: true }));
});

export default app;
