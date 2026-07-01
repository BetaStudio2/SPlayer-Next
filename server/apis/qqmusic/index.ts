/**
 * QM 主进程服务
 *
 * 与 netease 不同之处：
 * - 无持久化 session（uid/sid 是匿名态，内存缓存 1h 足够）
 * - 无 cookie 登录态（播放 URL 由插件实现，不走账号）
 * - 走 fetch 原生 HTTP，无加密 body（靠 UA + comm 伪装）
 *
 * 统一入口：callQQMusic(name, params)
 */

import { LRUCache } from "@main/apis/common/cache";
import { modules } from "./modules";
import type { QMParams } from "./core/types";

const apiCache = new LRUCache();

export const clearQQMusicCache = (): void => {
  apiCache.clear();
};

/**
 * 调用任意 QM API
 * @param name  见 modules/index.ts 中的 key（search / song_info / lyric / match / hot_search / leaderboard / song_list）
 * @param params 业务参数；不想命中缓存可传 `timestamp: Date.now()`
 */
export const callQQMusic = async (name: string, params: QMParams = {}): Promise<any> => {
  // hasOwn 守卫
  const fn = Object.hasOwn(modules, name) ? modules[name] : undefined;
  if (!fn) throw new Error(`unknown qm api: ${name}`);

  const key = LRUCache.key(name, params);
  const hit = apiCache.get(key);
  if (hit !== undefined) return hit;

  const value = await fn(params);
  apiCache.set(key, value);
  return value;
};
