import { Readable } from "node:stream";
import { createReadStream, existsSync, statSync } from "node:fs";
import path from "node:path";
import sharp from "sharp";
import type { Context } from "hono";
import { getTracksByIds } from "@main/database";
import { getCoverCacheDir } from "@main/utils/config";
import { serverLog } from "@main/utils/logger";

/** 音频扩展名 → Content-Type */
const AUDIO_MIME: Record<string, string> = {
  mp3: "audio/mpeg",
  flac: "audio/flac",
  ogg: "audio/ogg",
  opus: "audio/ogg",
  oga: "audio/ogg",
  m4a: "audio/mp4",
  aac: "audio/aac",
  wav: "audio/wav",
  ape: "audio/x-ape",
  wv: "audio/x-wavpack",
  dsf: "audio/x-dsf",
  dsd: "audio/x-dsd",
  dff: "audio/x-dff",
  mp4: "audio/mp4",
  aiff: "audio/aiff",
  aif: "audio/aiff",
};

const mimeOf = (filePath: string): string =>
  AUDIO_MIME[path.extname(filePath).slice(1).toLowerCase()] ?? "application/octet-stream";

/**
 * 流式提供音频文件，支持 HTTP Range 请求
 * GET /api/music/stream/:id
 */
export const serveTrackStream = async (c: Context, id: string): Promise<Response> => {
  const track = getTracksByIds([id])[0];
  if (!track?.path || !existsSync(track.path)) {
    return c.json({ success: false, error: "track not found" }, 404);
  }
  const filePath = track.path;
  const stat = statSync(filePath);
  const total = stat.size;
  const mime = mimeOf(filePath);

  const rangeHeader = c.req.header("range");
  if (!rangeHeader) {
    // 整文件
    const stream = Readable.toWeb(createReadStream(filePath)) as ReadableStream;
    return new Response(stream, {
      status: 200,
      headers: {
        "Content-Type": mime,
        "Content-Length": String(total),
        "Accept-Ranges": "bytes",
        "Cache-Control": "public, max-age=3600",
      },
    });
  }

  // 解析 bytes=start-end
  const m = /bytes=(\d*)-(\d*)/.exec(rangeHeader);
  if (!m) {
    return c.json({ success: false, error: "invalid range" }, 416);
  }
  const start = m[1] ? parseInt(m[1], 10) : 0;
  const end = m[2] ? parseInt(m[2], 10) : total - 1;
  if (start > end || start >= total) {
    return new Response(null, {
      status: 416,
      headers: { "Content-Range": `bytes */${total}` },
    });
  }
  const chunkSize = end - start + 1;
  const stream = Readable.toWeb(createReadStream(filePath, { start, end })) as ReadableStream;
  return new Response(stream, {
    status: 206,
    headers: {
      "Content-Type": mime,
      "Content-Length": String(chunkSize),
      "Content-Range": `bytes ${start}-${end}/${total}`,
      "Accept-Ranges": "bytes",
      "Cache-Control": "public, max-age=3600",
    },
  });
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
