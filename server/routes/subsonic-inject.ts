/**
 * Subsonic 在线歌词注入端点
 *
 * Go Subsonic 后端在查不到内嵌歌词时，回调此端点获取在线歌词。
 * TS 层通过 Netease API 搜索匹配，返回标准 LRC 格式歌词。
 *
 * 路由挂载于 /api/subsonic-inject/*，仅接受 Go 内部回环调用。
 */
import { Hono } from "hono";
import * as netease from "@main/apis/common/lyric/netease";
import { buildFingerprint, deleteMatchedId } from "@main/database/lyricMatchCache";
import { serverLog } from "@main/utils/logger";

const app = new Hono();

export interface InjectLyricRequest {
  /** 歌曲 ID（Subsonic track id，用于日志） */
  id?: string;
  /** 歌曲标题 */
  title: string;
  /** 歌手名 */
  artist?: string;
}

export interface InjectLyricResponse {
  main?: string;
  translation?: string;
  romaji?: string;
}

/** POST /lyrics — Go 回调获取在线歌词 */
app.post("/lyrics", async (c) => {
  const body = (await c.req.json().catch(() => null)) as InjectLyricRequest | null;
  if (!body?.title) {
    return c.json({});
  }

  serverLog.info(`[subsonic-inject] 在线歌词请求: "${body.title}" - "${body.artist ?? ""}"`);

  try {
    // 构建一个轻量 Track 对象供 Netease API 搜索
    const track = {
      id: body.id ?? "",
      title: body.title,
      artists: body.artist ? [{ name: body.artist }] : [],
    } as Parameters<typeof netease.getByQuery>[0];

    const fingerprint = buildFingerprint(track);

    const result = await netease.getByQuery(track);
    // 注入完成后立即丢弃缓存，确保在线歌词不持久化
    deleteMatchedId(fingerprint, "netease");
    if (result) {
      const resp: InjectLyricResponse = {};
      if (result.content) resp.main = result.content;
      if (result.translation) resp.translation = result.translation;
      if (result.romaji) resp.romaji = result.romaji;
      serverLog.info(`[subsonic-inject] 在线歌词命中: "${body.title}"`);
      return c.json(resp);
    }

    // getByQuery 可能返回 null（无匹配），回退到 getLrcByQuery
    const lrc = await netease.getLrcByQuery(track).catch(() => null);
    deleteMatchedId(fingerprint, "netease");
    if (lrc) {
      serverLog.info(`[subsonic-inject] 在线歌词(LRC)命中: "${body.title}"`);
      return c.json({ main: lrc });
    }

    serverLog.info(`[subsonic-inject] 在线歌词未匹配: "${body.title}"`);
    return c.json({});
  } catch (err) {
    serverLog.warn(`[subsonic-inject] 在线歌词失败: "${body.title}":`, err);
    return c.json({});
  }
});

export default app;
