import { existsSync } from "node:fs";
import path from "node:path";
import sharp from "sharp";
import type { Context } from "hono";
import { getTracksByIds } from "@main/database";
import { getCoverCacheDir } from "@main/utils/config";
import { serverLog } from "@main/utils/logger";
import { serveAudioStream } from "@main/utils/stream";

/**
 * 流式提供音频文件，支持 HTTP Range 请求
 * GET /api/music/stream/:id
 */
export const serveTrackStream = async (c: Context, id: string): Promise<Response> => {
  const track = getTracksByIds([id])[0];
  if (!track?.path || !existsSync(track.path)) {
    return c.json({ success: false, error: "track not found" }, 404);
  }
  return serveAudioStream(c, track.path);
};

/**
 * 提供曲目封面（嵌入封面缓存），可选 ?size= 缩略图
 * GET /api/music/cover/:id?size=300
 */
export const serveTrackCover = async (c: Context, id: string): Promise<Response> => {
  const coverPath = path.join(getCoverCacheDir(), `${id}.img`);
  if (!existsSync(coverPath)) {
    return c.json({ success: false, error: "cover not found" }, 404);
  }
  const sizeParam = c.req.query("size");
  const size = sizeParam ? parseInt(sizeParam, 10) : 0;

  try {
    if (size > 0) {
      const buf = await sharp(coverPath)
        .resize(size, size, { fit: "inside", withoutEnlargement: true })
        .jpeg({ quality: 85 })
        .toBuffer();
      return new Response(buf, {
        status: 200,
        headers: {
          "Content-Type": "image/jpeg",
          "Cache-Control": "public, max-age=86400",
        },
      });
    }
    // 原图：转 jpeg 输出以保证内容类型一致
    const buf = await sharp(coverPath).jpeg({ quality: 90 }).toBuffer();
    return new Response(buf, {
      status: 200,
      headers: {
        "Content-Type": "image/jpeg",
        "Cache-Control": "public, max-age=86400",
      },
    });
  } catch (err) {
    serverLog.warn(`[cover] 处理封面失败 ${id}:`, err);
    return c.json({ success: false, error: "cover process failed" }, 500);
  }
};
