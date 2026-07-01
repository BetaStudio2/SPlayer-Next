/**
 * 通用 LRU 内存缓存
 *
 * 替换各平台（netease / qqmusic / kugou）手写的 Map 缓存实现。
 * 基于 Map 的 LRU 淘汰（命中时 re-insert 到末尾）。
 */

import { createHash } from "node:crypto";

interface CacheEntry<V> {
  value: V;
  expireAt: number;
}

export interface LRUCacheOptions<V> {
  /** 默认 TTL（毫秒），默认 2 分钟 */
  ttl?: number;
  /** 容量上限，默认 200 */
  maxEntries?: number;
  /** 写入前判断是否应该缓存（可用于过滤空结果） */
  shouldCache?: (value: V) => boolean;
}

export class LRUCache<V = unknown> {
  private store = new Map<string, CacheEntry<V>>();
  private ttl: number;
  private maxEntries: number;
  private shouldCache: (value: V) => boolean;

  constructor(options: LRUCacheOptions<V> = {}) {
    this.ttl = options.ttl ?? 2 * 60 * 1000;
    this.maxEntries = options.maxEntries ?? 200;
    this.shouldCache = options.shouldCache ?? (() => true);
  }

  /** 构造缓存 key：name|md5(params) 8 位前缀 */
  static key(name: string, params: unknown): string {
    const hash = createHash("md5")
      .update(JSON.stringify(params ?? {}))
      .digest("hex")
      .slice(0, 8);
    return `${name}|${hash}`;
  }

  get(key: string): V | undefined {
    const hit = this.store.get(key);
    if (!hit) return undefined;
    if (hit.expireAt <= Date.now()) {
      this.store.delete(key);
      return undefined;
    }
    // LRU：命中时重新插入到末尾
    this.store.delete(key);
    this.store.set(key, hit);
    return hit.value;
  }

  set(key: string, value: V, ttl?: number): void {
    if (!this.shouldCache(value)) return;
    if (this.store.size >= this.maxEntries) {
      const oldest = this.store.keys().next().value;
      if (oldest !== undefined) this.store.delete(oldest);
    }
    this.store.set(key, {
      value,
      expireAt: Date.now() + (ttl ?? this.ttl),
    });
  }

  clear(): void {
    this.store.clear();
  }

  get size(): number {
    return this.store.size;
  }
}
