/**
 * Subsonic 鉴权中间件
 *
 * 支持两种鉴权方式：
 *   1. token + salt（推荐）
 *   2. 明文密码（兼容老客户端，可能带 enc:hex: 前缀）
 *
 * POST 表单支持（OpenSubsonic formPost 扩展）：从 formData 中读取 u/p/t/s
 */
import { createHash } from "node:crypto";
import type { MiddlewareHandler } from "hono";
import { getUserByUsername, type SubsonicUser } from "@main/database/subsonic";

interface SubError {
  code: number;
  message: string;
}

declare module "hono" {
  interface ContextVariableMap {
    subsonicUser: SubsonicUser;
  }
}

const SUBSONIC_VERSION = "1.16.1";
const SERVER_NAME = "splayer";
const SERVER_VERSION = "1.0.0";

const md5 = (s: string): string => createHash("md5").update(s).digest("hex");

/** 验证 Subsonic 鉴权参数 */
export const authenticate = (u?: string, p?: string, t?: string, s?: string): SubsonicUser => {
  if (!u) throw { code: 10, message: "Missing required parameter u" } as SubError;
  const user = getUserByUsername(u);
  if (!user) throw { code: 40, message: "Wrong username or password" } as SubError;

  // token + salt 模式
  if (t && s) {
    const expected = md5(user.password + s);
    if (expected !== t) throw { code: 40, message: "Wrong username or password" } as SubError;
    return user;
  }
  // 明文密码模式（可能带 enc:hex: 前缀）
  if (p) {
    let plain = p;
    if (plain.startsWith("enc:hex:")) {
      plain = Buffer.from(plain.slice(8), "hex").toString("utf-8");
    }
    if (plain !== user.password) throw { code: 40, message: "Wrong username or password" } as SubError;
    return user;
  }
  throw { code: 10, message: "Missing authentication" } as SubError;
};

/** 鉴权中间件：解析 u/p/t/s，挂到 c.var.subsonicUser */
export const authMiddleware: MiddlewareHandler = async (c, next) => {
  try {
    const q = c.req.query();
    let u = q.u, p = q.p, t = q.t, s = q.s;
    // POST 表单支持
    if (!u && c.req.method === "POST") {
      const form = await c.req.formData().catch(() => null);
      if (form) {
        u = form.get("u") as string | undefined ?? u;
        p = form.get("p") as string | undefined ?? p;
        t = form.get("t") as string | undefined ?? t;
        s = form.get("s") as string | undefined ?? s;
      }
    }
    const user = authenticate(u, p, t, s);
    c.set("subsonicUser", user);
    await next();
  } catch (err) {
    const e = err as SubError;
    // 不依赖 send()，直接返回错误 JSON，避免循环依赖
    return c.json({
      "subsonic-response": {
        status: "failed",
        version: SUBSONIC_VERSION,
        type: SERVER_NAME,
        serverVersion: SERVER_VERSION,
        error: { code: e.code, message: e.message },
      },
    });
  }
};
