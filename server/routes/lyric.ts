import { Hono } from "hono";
import * as netease from "@main/apis/common/lyric/netease";
import * as qqmusic from "@main/apis/common/lyric/qqmusic";
import * as kugou from "@main/apis/common/lyric/kugou";
import { fetchTTML } from "@main/apis/common/lyric/ttml";
import { buildFingerprint, getMatchedId } from "@main/database/lyricMatchCache";
import { coreLog } from "@main/utils/logger";
import type { ApiPlatform } from "@shared/types/apis";
import type { Track } from "@shared/types/player";

const app = new Hono();

/** 并发去重 */
const inflight = new Map<string, Promise<unknown>>();
const dedup = <T>(key: string, run: () => Promise<T>): Promise<T> => {
  const existing = inflight.get(key) as Promise<T> | undefined;
  if (existing) return existing;
  const p = run().finally(() => {
    if (inflight.get(key) === p) inflight.delete(key);
  });
  inflight.set(key, p);
  return p;
};

/** 按 (platform, id) 直取 */
const resolveById = async (
  platform: ApiPlatform,
  id: string,
): Promise<{ ok: true; data: unknown } | { ok: false; error: string }> => {
  try {
    switch (platform) {
      case "netease":
        return { ok: true, data: await netease.getByPlatformId(id) };
      case "qqmusic":
        return { ok: true, data: await qqmusic.getByPlatformId(id) };
      case "kugou":
        return { ok: true, data: await kugou.getByPlatformId(id) };
      default:
        return { ok: false, error: `unsupported platform: ${platform}` };
    }
  } catch (err) {
    coreLog.warn(`[lyric] matchById(${platform}, ${id}) failed:`, err);
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
};

/** 按 Track 元数据模糊匹配 */
const resolveByQuery = async (
  platform: ApiPlatform,
  track: Track,
): Promise<{ ok: true; data: unknown } | { ok: false; error: string }> => {
  try {
    switch (platform) {
      case "netease":
        return { ok: true, data: await netease.getByQuery(track) };
      case "qqmusic":
        return { ok: true, data: await qqmusic.getByQuery(track) };
      case "kugou":
        return { ok: true, data: await kugou.getByQuery(track) };
      default:
        return { ok: false, error: `unsupported platform: ${platform}` };
    }
  } catch (err) {
    coreLog.warn(`[lyric] matchByQuery(${platform}, ${track.title}) failed:`, err);
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
};

/** TTML 高质量歌词覆盖 */
const resolveTTMLOverlay = async (
  track: Track,
  platform: "netease" | "qqmusic",
): Promise<{ ok: true; data: unknown } | { ok: false; error: string }> => {
  try {
    const ids: string[] = [];
    const push = (v?: string) => {
      if (v && !ids.includes(v)) ids.push(v);
    };
    const fingerprint = buildFingerprint(track);
    const cached = getMatchedId(fingerprint, platform);
    if (platform === "qqmusic") push(cached?.extra?.mid);
    if (track.source === platform) push(track.id);
    if (track.source === platform) push(track.extId);
    push(cached?.platformId);
    if (ids.length === 0) return { ok: true, data: null };
    return { ok: true, data: await fetchTTML(platform, ids) };
  } catch (err) {
    coreLog.warn(`[lyric] fetchTTMLOverlay(${platform}, ${track.title}) failed:`, err);
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
};

/** POST /matchById  body={platform,id} */
app.post("/matchById", async (c) => {
  const { platform, id } = (await c.req.json().catch(() => ({}))) as {
    platform?: ApiPlatform;
    id?: string;
  };
  if (!platform || !id) return c.json({ ok: false, error: "missing platform/id" });
  return c.json(await dedup(`byId:${platform}:${id}`, () => resolveById(platform, id)));
});

/** POST /matchByQuery  body={platform,track} */
app.post("/matchByQuery", async (c) => {
  const { platform, track } = (await c.req.json().catch(() => ({}))) as {
    platform?: ApiPlatform;
    track?: Track;
  };
  if (!platform || !track) return c.json({ ok: false, error: "missing platform/track" });
  return c.json(
    await dedup(`byQuery:${platform}:${track.id}`, () => resolveByQuery(platform, track)),
  );
});

/** POST /ttml  body={track,platform} */
app.post("/ttml", async (c) => {
  const { track, platform } = (await c.req.json().catch(() => ({}))) as {
    track?: Track;
    platform?: "netease" | "qqmusic";
  };
  if (!track || !platform) return c.json({ ok: false, error: "missing track/platform" });
  return c.json(await dedup(`ttml:${platform}:${track.id}`, () => resolveTTMLOverlay(track, platform)));
});

export default app;
