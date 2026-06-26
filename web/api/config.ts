/**
 * window.api.config mock：配置读写转发到 server /api/config
 * 服务端持久化，多端一致；内存缓存避免重复请求
 */
import type { ConfigApi } from "@shared/types/settings";
import type { SystemConfig } from "@shared/types/settings";

let cache: SystemConfig | null = null;

const fetchAll = async (): Promise<SystemConfig> => {
  if (cache) return cache;
  const res = await fetch("/api/config");
  cache = (await res.json()) as SystemConfig;
  return cache!;
};

const getByPath = (obj: unknown, path: string): unknown => {
  return path.split(".").reduce<unknown>((acc, key) => {
    return acc && typeof acc === "object" ? (acc as Record<string, unknown>)[key] : undefined;
  }, obj);
};

const setByPath = (obj: Record<string, unknown>, path: string, value: unknown): void => {
  const keys = path.split(".");
  let cur = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    const k = keys[i];
    if (cur[k] == null || typeof cur[k] !== "object") cur[k] = {};
    cur = cur[k] as Record<string, unknown>;
  }
  cur[keys[keys.length - 1]] = value;
};

export const configApi: ConfigApi = {
  async get(keyPath: string): Promise<unknown> {
    const all = await fetchAll();
    return getByPath(all, keyPath);
  },

  async set(keyPath: string, value: unknown): Promise<void> {
    // 乐观更新内存
    if (cache) {
      setByPath(cache as unknown as Record<string, unknown>, keyPath, value);
    }
    await fetch(`/api/config/${keyPath}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(value),
    });
  },

  async getAll(): Promise<SystemConfig> {
    return fetchAll();
  },

  async reset(): Promise<void> {
    await fetch("/api/config/reset", { method: "POST" });
    cache = null;
  },

  async replaceAll(config: unknown): Promise<void> {
    await fetch("/api/config/replace", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(config),
    });
    cache = null;
  },

  async exportToFile(payload: unknown): Promise<{ ok: boolean; reason?: "canceled" | "writeFailed" }> {
    // 浏览器下载 JSON 备份
    try {
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "splayer-config-backup.json";
      a.click();
      URL.revokeObjectURL(url);
      return { ok: true };
    } catch {
      return { ok: false, reason: "writeFailed" };
    }
  },

  async importFromFile(): Promise<
    { ok: true; data: unknown } | { ok: false; reason: "canceled" | "readFailed" | "parseFailed" }
  > {
    return new Promise((resolve) => {
      const input = document.createElement("input");
      input.type = "file";
      input.accept = "application/json,.json";
      input.onchange = () => {
        const file = input.files?.[0];
        if (!file) return resolve({ ok: false, reason: "canceled" });
        const reader = new FileReader();
        reader.onload = () => {
          try {
            resolve({ ok: true, data: JSON.parse(reader.result as string) });
          } catch {
            resolve({ ok: false, reason: "parseFailed" });
          }
        };
        reader.onerror = () => resolve({ ok: false, reason: "readFailed" });
        reader.readAsText(file);
      };
      input.click();
    });
  },
};
