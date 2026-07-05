/**
 * 歌曲评论 API
 *
 * 转发前端评论请求到网易云 API。
 * 使用服务端的 callNetease 获取评论数据并归一化。
 */

import { Hono } from "hono";
import { callNetease } from "@main/apis/netease";
import { coreLog } from "@main/utils/logger";
import type { MusicCommentPage, MusicCommentQuery } from "@shared/types/comment";
import type { Track } from "@shared/types/player";

const app = new Hono();

const NETEASE_SOURCE_ID = "builtin:netease";
const NETEASE_RESOURCE_TYPE = "R_SO_4_";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

interface CommentItem {
  commentId?: number;
  user?: {
    userId: number;
    nickname: string;
    avatarUrl: string;
  };
  content: string;
  time: number;
  likedCount: number;
  ipLocation?: {
    location: string;
  };
  beReplied?: Array<{
    beRepliedCommentId: number;
    user: { nickname: string };
    content: string;
  }>;
}

const normalizeNeteaseCommentPage = (
  body: Record<string, unknown>,
  type: string,
  page: number,
  limit: number,
): MusicCommentPage => {
  const items: CommentItem[] = (type === "hot"
    ? (body.hotComments as CommentItem[])
    : (body.comments as CommentItem[])) ?? [];

  return {
    total: (body.total as number) ?? items.length,
    page,
    limit,
    list: items.map((item: CommentItem) => ({
      id: String(item.commentId ?? ""),
      userId: String(item.user?.userId ?? ""),
      userName: item.user?.nickname ?? "",
      avatar: item.user?.avatarUrl ?? "",
      text: item.content ?? "",
      time: item.time ?? 0,
      location: item.ipLocation?.location ?? "",
      likedCount: item.likedCount ?? 0,
      replyTotal: item.beReplied?.length ?? 0,
      reply: item.beReplied?.map((r) => ({
        id: String(r.beRepliedCommentId),
        userName: r.user?.nickname ?? "",
        text: r.content ?? "",
      })),
    })),
  };
};

const getNeteaseId = async (track: Track): Promise<string | null> => {
  if (track.source === "netease" && track.id) return track.id;
  const keyword = `${track.title} ${track.artists.map((a) => a.name).join(" ")}`.trim();
  if (!keyword) return null;
  try {
    const { status, body } = await callNetease("search", {
      keywords: keyword,
      type: 1,
      limit: 20,
    });
    if (status !== 200) return null;
    const songs = (body.result as Record<string, unknown>)?.songs as Array<{
      id: number | string;
    }> | undefined;
    return songs?.[0] ? String(songs[0].id) : null;
  } catch {
    return null;
  }
};

const normalizeQuery = (args: MusicCommentQuery): MusicCommentQuery => ({
  ...args,
  page: Math.max(1, Math.floor(Number(args.page) || 1)),
  limit: Math.min(MAX_LIMIT, Math.max(1, Math.floor(Number(args.limit) || DEFAULT_LIMIT))),
});

/** POST / 获取评论 */
app.post("/", async (c) => {
  const args = normalizeQuery((await c.req.json().catch(() => ({}))) as MusicCommentQuery);
  if (args.sourceId !== NETEASE_SOURCE_ID) {
    return c.json({ ok: false, error: `unsupported comment source: ${args.sourceId}` });
  }

  try {
    const id = await getNeteaseId(args.track);
    if (!id) return c.json({ ok: true, data: { list: [], total: 0, page: args.page, limit: args.limit } });

    const apiName = args.type === "hot" ? "comment_hot" : "comment_music";
    const { body } = await callNetease(apiName, {
      id,
      type: NETEASE_RESOURCE_TYPE,
      limit: args.limit,
      offset: (args.page - 1) * args.limit,
    });

    const data = normalizeNeteaseCommentPage(body, args.type, args.page, args.limit);
    return c.json({ ok: true, data });
  } catch (err) {
    coreLog.warn("[comments] get failed:", err);
    return c.json({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
});

/** GET /sources 获取可用评论源 */
app.get("/sources", (c) => {
  return c.json([
    { id: NETEASE_SOURCE_ID, name: "网易云音乐", kind: "builtin", platform: "netease" },
  ]);
});

export default app;
