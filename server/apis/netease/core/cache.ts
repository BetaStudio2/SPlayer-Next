/**
 * 接口响应内存缓存
 *
 * 对齐原 @neteasecloudmusicapienhanced/api util/apicache.js 的行为：
 * - 默认 2 分钟 TTL
 * - 只缓存 status === 200 的响应
 * - key = `${name}|${md5(params)}`
 */

import { LRUCache } from "@main/apis/common/cache";

interface CacheValue {
  status: number;
  body: unknown;
}

const apiCache = new LRUCache<CacheValue>({
  shouldCache: (v) => v.status === 200,
});

/** 构造缓存 key */
export const buildCacheKey = (name: string, params: unknown): string => LRUCache.key(name, params);

export const cacheGet = (key: string): CacheValue | undefined => apiCache.get(key);
export const cacheSet = (key: string, value: CacheValue, ttl?: number): void => apiCache.set(key, value, ttl);
export const cacheClear = (): void => apiCache.clear();
