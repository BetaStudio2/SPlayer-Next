/**
 * 流媒体服务器凭据路由
 *
 * 存储路径：data/config/streaming.json
 * 敏感字段（password / accessToken）使用 AES-256-GCM 加密
 *
 * GET  /api/streaming       → 返回明文 servers（解密后，前端内存使用）
 * PUT  /api/streaming       → 保存 servers（加密 password 后落盘）
 *
 * 替代桌面端 localStorage 明文存储，避免浏览器端泄露密码。
 */
import { Hono } from "hono";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { configDir } from "@main/utils/paths";
import { encryptString, decryptString } from "@main/utils/crypto";
import { serverLog } from "@main/utils/logger";
import type { StreamingServerConfig, StreamingServerType } from "@shared/types/streaming";

const app = new Hono();
const STORE_PATH = path.join(configDir, "streaming.json");

interface StoredPayload {
  servers: StreamingServerConfig[];
  activeServerId: string | null;
}

/** 读取并解密 */
const loadStored = (): StoredPayload => {
  try {
    if (!existsSync(STORE_PATH)) return { servers: [], activeServerId: null };
    const raw = JSON.parse(readFileSync(STORE_PATH, "utf-8")) as StoredPayload;
    // 解密敏感字段
    const servers = (raw.servers ?? []).map((s) => ({
      ...s,
      password: s.password ? decryptString(s.password) : "",
      accessToken: s.accessToken ? decryptString(s.accessToken) : undefined,
    }));
    return { servers, activeServerId: raw.activeServerId ?? null };
  } catch (err) {
    serverLog.warn("[streaming] 读取凭据失败:", err);
    return { servers: [], activeServerId: null };
  }
};

/** 加密敏感字段后落盘 */
const saveStored = (payload: StoredPayload): void => {
  const dir = path.dirname(STORE_PATH);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  // 加密敏感字段（空密码不加密，保持空串）
  const servers = payload.servers.map((s) => ({
    ...s,
    password: s.password ? encryptString(s.password) : "",
    accessToken: s.accessToken ? encryptString(s.accessToken) : undefined,
  }));
  writeFileSync(STORE_PATH, JSON.stringify({ servers, activeServerId: payload.activeServerId }, null, 2));
};

/** GET / —— 返回明文（解密后） */
app.get("/", (c) => c.json(loadStored()));

/** PUT / —— 保存（加密 password / accessToken 后落盘） */
app.put("/", async (c) => {
  const payload = (await c.req.json().catch(() => null)) as StoredPayload | null;
  if (!payload || !Array.isArray(payload.servers)) {
    return c.json({ error: "invalid payload" }, 400);
  }
  try {
    saveStored(payload);
    return c.json({ ok: true });
  } catch (err) {
    serverLog.error("[streaming] 保存凭据失败:", err);
    return c.json({ error: "save failed" }, 500);
  }
});

// ─── 音频流代理 ─────────────────────────────────────────────
// GET /stream/:serverId?id=xxx&playSessionId=xxx
// 服务端注入凭据 → fetch 流媒体服务器 → 透传响应（含 Range seek）
// 前端 <audio> 只看到 /api/streaming/stream/xxx，凭据不暴露给浏览器
// ──────────────────────────────────────────────────────────

const SUBSONIC_API_VERSION = "1.16.1";
const CLIENT_NAME = "SPlayer-Next";

/** Subsonic 系鉴权参数（salt + md5 token） */
const buildSubsonicAuth = (cfg: StreamingServerConfig): URLSearchParams => {
  const salt = randomBytes(6).toString("hex");
  const token = createHash("md5").update(cfg.password + salt).digest("hex");
  return new URLSearchParams({
    u: cfg.username,
    t: token,
    s: salt,
    v: SUBSONIC_API_VERSION,
    c: CLIENT_NAME,
    f: "json",
  });
};

/** 判断是否 Subsonic 系 */
const isSubsonic = (type: StreamingServerType): boolean =>
  type === "subsonic" || type === "navidrome" || type === "opensubsonic" ||
  type === "airsonic" || type === "gonic" || type === "lms";

/** 设备 ID（稳定，与前端 jellyfin.ts 对齐） */
const deviceId = (cfg: StreamingServerConfig): string =>
  createHash("md5").update(`splayer-${cfg.id}`).digest("hex").slice(0, 16);

/** 构造流媒体服务器的真实流 URL（凭据在服务端生成，不暴露给前端） */
const buildUpstreamStreamUrl = (
  cfg: StreamingServerConfig,
  songId: string,
  playSessionId?: string,
): string => {
  const base = cfg.url.replace(/\/+$/, "");
  if (isSubsonic(cfg.type)) {
    const params = buildSubsonicAuth(cfg);
    params.set("id", songId);
    params.set("estimateContentLength", "true");
    params.set("format", "raw");
    params.set("maxBitRate", "0");
    return `${base}/rest/stream.view?${params}`;
  }
  // Jellyfin / Emby
  if (!cfg.accessToken) throw new Error("缺少 accessToken，请先连接服务器");
  const params = new URLSearchParams({
    UserId: cfg.userId ?? "",
    DeviceId: deviceId(cfg),
    Container: "mp3,m4a|aac,m4a|alac,m4b|aac,flac,webma|opus,webm|opus,ogg|opus,ogg|vorbis,wav,oga",
    PlaySessionId: playSessionId ?? cryptoRandomUUID(),
    api_key: cfg.accessToken,
  });
  return `${base}/Audio/${encodeURIComponent(songId)}/stream?${params}`;
};

/** crypto.randomUUID 兼容（Node 18+ 有全局 crypto） */
const cryptoRandomUUID = (): string => {
  try {
    return crypto.randomUUID();
  } catch {
    return randomBytes(16).toString("hex");
  }
};

/** 透传上游响应头（只保留音频相关，过滤鉴权信息） */
const FORWARD_HEADERS = [
  "content-type",
  "content-length",
  "content-range",
  "accept-ranges",
];

app.get("/stream/:serverId", async (c) => {
  const { serverId } = c.req.param();
  const songId = c.req.query("id");
  const playSessionId = c.req.query("playSessionId") ?? undefined;
  if (!songId) return c.text("missing id", 400);

  const stored = loadStored();
  const cfg = stored.servers.find((s) => s.id === serverId);
  if (!cfg) return c.text("server not found", 404);

  let upstreamUrl: string;
  try {
    upstreamUrl = buildUpstreamStreamUrl(cfg, songId, playSessionId);
  } catch (err) {
    serverLog.warn("[streaming] 构造流 URL 失败:", err);
    return c.text(err instanceof Error ? err.message : "auth failed", 401);
  }

  // 透传 Range 头（seek 支持）
  const headers: Record<string, string> = {};
  const range = c.req.header("range");
  if (range) headers.range = range;

  try {
    const upstream = await fetch(upstreamUrl, { headers });
    if (!upstream.ok || !upstream.body) {
      serverLog.warn(`[streaming] 上游返回 ${upstream.status}`);
      return c.text(`upstream ${upstream.status}`, upstream.status as 400);
    }
    // 透传响应头
    for (const name of FORWARD_HEADERS) {
      const val = upstream.headers.get(name);
      if (val) c.header(name, val);
    }
    // Hono c.body 接受 Web ReadableStream
    return new Response(upstream.body as ReadableStream, {
      status: upstream.status,
      headers: c.res.headers,
    });
  } catch (err) {
    serverLog.error("[streaming] 流代理失败:", err);
    return c.text("upstream error", 502);
  }
});

// ─── 连接探测 / 登录代理 ─────────────────────────────────────
// POST /probe  body: StreamingServerConfig（含 type/url/username/password，可选 accessToken/userId）
// 服务端代为 ping 流媒体服务器，jellyfin/emby 在缺少 accessToken 时自动 AuthenticateByName
// 返回 { ok, version?, error?, accessToken?, userId? } —— 浏览器无需直连流媒体服务器
// ──────────────────────────────────────────────────────────

interface ProbeResult {
  ok: boolean;
  version?: string;
  error?: string;
  accessToken?: string;
  userId?: string;
}

/** 构造 Subsonic ping URL */
const subsonicPingUrl = (cfg: StreamingServerConfig): string => {
  const base = cfg.url.replace(/\/+$/, "");
  const params = buildSubsonicAuth(cfg);
  return `${base}/rest/ping.view?${params}`;
};

/** 构造 Jellyfin/Emby ping URL（System/Info/Public，无需鉴权但用于探测可达性） */
const jellyPingUrl = (cfg: StreamingServerConfig): string =>
  `${cfg.url.replace(/\/+$/, "")}/System/Info/Public`;

/** Jellyfin/Emby 登录拿 token */
const jellyAuthenticate = async (
  cfg: StreamingServerConfig,
): Promise<{ accessToken: string; userId: string }> => {
  const base = cfg.url.replace(/\/+$/, "");
  const res = await fetch(`${base}/Users/AuthenticateByName`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Emby-Authorization": `MediaBrowser Client="${CLIENT_NAME}", Device="SPlayer-Web", DeviceId="${deviceId(cfg)}", Version="1.0.0"`,
    },
    body: JSON.stringify({ Username: cfg.username, Pw: cfg.password }),
  });
  if (!res.ok) throw new Error(`登录失败: HTTP ${res.status}`);
  const json = (await res.json()) as { AccessToken?: string; User?: { Id?: string } };
  if (!json.AccessToken || !json.User?.Id) throw new Error("登录响应缺少 AccessToken/UserId");
  return { accessToken: json.AccessToken, userId: json.User.Id };
};

app.post("/probe", async (c) => {
  const cfg = (await c.req.json().catch(() => null)) as Partial<StreamingServerConfig> | null;
  if (!cfg || !cfg.type || !cfg.url) return c.json({ ok: false, error: "missing fields" } satisfies ProbeResult, 400);

  // 构造完整 cfg（补默认值）
  const full: StreamingServerConfig = {
    id: cfg.id ?? "__probe__",
    name: cfg.name ?? "probe",
    type: cfg.type,
    url: cfg.url,
    username: cfg.username ?? "",
    password: cfg.password ?? "",
    accessToken: cfg.accessToken,
    userId: cfg.userId,
    lastConnected: undefined,
  };

  try {
    let accessToken = full.accessToken;
    let userId = full.userId;

    // Jellyfin/Emby 缺 token 时先登录
    if (!isSubsonic(full.type) && !accessToken) {
      const auth = await jellyAuthenticate(full);
      accessToken = auth.accessToken;
      userId = auth.userId;
    }

    // ping
    const pingUrl = isSubsonic(full.type)
      ? subsonicPingUrl(full)
      : jellyPingUrl(full);
    const pingRes = await fetch(pingUrl);
    if (!pingRes.ok) {
      return c.json({ ok: false, error: `HTTP ${pingRes.status}` } satisfies ProbeResult);
    }
    const json = (await pingRes.json()) as {
      version?: string;
      serverVersion?: string;
      Version?: string;
    };
    const version = isSubsonic(full.type)
      ? json.serverVersion ?? json.version
      : json.Version;

    return c.json({
      ok: true,
      version,
      accessToken,
      userId,
    } satisfies ProbeResult);
  } catch (err) {
    return c.json({
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    } satisfies ProbeResult);
  }
});

// ─── 封面/图片代理 ─────────────────────────────────────────
// GET /cover/:serverId?url=<encoded_url_without_auth>
// 前端 strip auth 后的 cover URL 经服务端注入凭据再透传，避免 CORS + 凭据暴露
// ──────────────────────────────────────────────────────────

const COVER_FORWARD_HEADERS = [
  "content-type",
  "content-length",
  "cache-control",
  "etag",
  "last-modified",
];

app.get("/cover/:serverId", async (c) => {
  const { serverId } = c.req.param();
  const rawUrl = c.req.query("url");
  if (!rawUrl) return c.text("missing url", 400);

  const stored = loadStored();
  const cfg = stored.servers.find((s) => s.id === serverId);
  if (!cfg) return c.text("server not found", 404);

  let upstream: URL;
  try {
    upstream = new URL(rawUrl);
  } catch {
    return c.text("invalid url", 400);
  }

  // 注入鉴权参数（前端已 strip，服务端重新附上）
  if (isSubsonic(cfg.type)) {
    const auth = buildSubsonicAuth(cfg);
    for (const [k, v] of auth) upstream.searchParams.set(k, v);
  } else if (cfg.accessToken) {
    upstream.searchParams.set("api_key", cfg.accessToken);
  }

  try {
    const res = await fetch(upstream.toString());
    if (!res.ok || !res.body) {
      return c.text(`upstream ${res.status}`, res.status as 400);
    }
    for (const name of COVER_FORWARD_HEADERS) {
      const val = res.headers.get(name);
      if (val) c.header(name, val);
    }
    return new Response(res.body as ReadableStream, {
      status: res.status,
      headers: c.res.headers,
    });
  } catch (err) {
    serverLog.error("[streaming] cover 代理失败:", err);
    return c.text("upstream error", 502);
  }
});

export default app;
