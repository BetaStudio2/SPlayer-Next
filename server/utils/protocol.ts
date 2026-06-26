import path from "node:path";
import { getAppCacheDir } from "./config";

/**
 * 服务端 cache 协议 shim
 *
 * 桌面端用 cache:// 自定义协议读取本地缓存图；服务端改为 HTTP 路径 `/api/cache/...`，
 * 由 index.ts 的静态路由从磁盘读取返回。注册类函数保留为 no-op 以兼容引用。
 */

/** cache URL 前缀（HTTP 形式） */
const CACHE_PREFIX = "/api/cache/";

/** 注册 cache 协议方案（服务端 no-op） */
export const registerCacheScheme = (): void => {
  /* no-op: 服务端用 HTTP 路由而非自定义协议 */
};

/** 注册 cache 协议处理（服务端 no-op） */
export const handleCacheProtocol = (): void => {
  /* no-op */
};

/** 在指定 partition 上注册 cache 协议处理（服务端 no-op） */
export const handleCacheProtocolOnPartition = (_partition: string): void => {
  /* no-op */
};

/**
 * 将 app-cache 下的磁盘路径转为 HTTP 缓存 URL
 * @param filePath 磁盘路径（如 /app/data/cache/artists/xxx.jpg）
 * @returns /api/cache/artists/xxx.jpg 或 undefined
 */
export const toCacheUrl = (filePath: string | undefined | null): string | undefined => {
  if (!filePath) return undefined;
  const relative = path.relative(getAppCacheDir(), filePath);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return undefined;
  return `${CACHE_PREFIX}${relative.replace(/\\/g, "/")}`;
};
