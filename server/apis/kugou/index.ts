/**
 * KG 主进程服务
 *
 * 与 netease 不同之处：
 * - 无账号体系、无 cookie、无加密 body，纯 fetch GET
 * - 搜索主走 mobilecdn.kugou.com（响应里有封面），失败兜底 songsearch.kugou.com（无封面）
 * - 歌词走 lyrics.kugou.com（需 KG-RC/KG-THash/UA 伪装 PC 客户端）
 * - 歌词是 hash + 歌名 + 时长 三元组匹配（KG 特有，不能只凭 ID）
 *
 * 统一入口：callKugou(name, params)
 */

import { LRUCache } from "@main/apis/common/cache";
import { modules } from "./modules";
import type { KGParams } from "./core/types";

const isEmptyResult = (value: unknown): boolean => {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  if (Array.isArray(v.songs) && v.songs.length === 0) return true;
  return false;
};

const apiCache = new LRUCache({
  shouldCache: (v) => !isEmptyResult(v),
});

export const clearKugouCache = (): void => {
  apiCache.clear();
};

/**
 * 调用任意 KG API
 * @param name   见 modules/index.ts（search / lyric）
 * @param params 业务参数；不想命中缓存可传 `timestamp: Date.now()`
 */
export const callKugou = async (name: string, params: KGParams = {}): Promise<any> => {
  // hasOwn 守卫
  const fn = Object.hasOwn(modules, name) ? modules[name] : undefined;
  if (!fn) throw new Error(`unknown kg api: ${name}`);

  const key = LRUCache.key(name, params);
  const hit = apiCache.get(key);
  if (hit !== undefined) return hit;

  const value = await fn(params);
  apiCache.set(key, value);
  return value;
};
