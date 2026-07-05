/**
 * window.api.comments mock：评论转发到 server /api/comments
 */
import type { CommentsApi, CommentSource, MusicCommentQuery, MusicCommentResponse } from "@shared/types/comment";

const post = async (path: string, body: unknown): Promise<Response> =>
  fetch(`/api/comments${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

const get = async (path: string): Promise<Response> =>
  fetch(`/api/comments${path}`);

export const commentsApi: CommentsApi = {
  async sources(): Promise<CommentSource[]> {
    try {
      const res = await get("/sources");
      return (await res.json()) as CommentSource[];
    } catch (err) {
      console.warn("[comments] failed to load sources:", err);
      return [];
    }
  },

  async get(args: MusicCommentQuery): Promise<MusicCommentResponse> {
    try {
      const res = await post("/", args);
      return (await res.json()) as MusicCommentResponse;
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : "network error" };
    }
  },
};
