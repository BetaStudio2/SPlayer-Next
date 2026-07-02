import { createReadStream, existsSync } from "node:fs";
import { open } from "node:fs/promises";
import { Readable } from "node:stream";
import path from "node:path";
import type { Context } from "hono";
import { getTracksByIds } from "@main/database";
import { getCoverCacheDir } from "@main/utils/config";
import { serveAudioStream } from "@main/utils/stream";

/** 通过文件头魔数检测封面图片 MIME 类型 */
const detectMime = async (filePath: string): Promise<string | undefined> => {
  let fd: Awaited<ReturnType<typeof open>> | undefined;
  try {
    fd = await open(filePath, "r");
    const buf = Buffer.alloc(4);
    const { bytesRead } = await fd.read(buf, 0, 4, 0);
    if (bytesRead < 4) return undefined;
    // JPEG: FF D8 FF
    if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
    // PNG: 89 50 4E 47
    if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47)
      return "image/png";
    return "application/octet-stream";
  } catch {
    return undefined;
  } finally {
    await fd?.close();
  }
};

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
 * 提供曲目封面（流式直出，无 sharp 重编码，零内存膨胀）
 * GET /api/music/cover/:id
 */
export const serveTrackCover = async (c: Context, id: string): Promise<Response> => {
  const coverPath = path.join(getCoverCacheDir(), `${id}.img`);
  if (!existsSync(coverPath)) {
    return c.json({ success: false, error: "cover not found" }, 404);
  }
  const mime = (await detectMime(coverPath)) ?? "image/jpeg";
  const stream = Readable.toWeb(createReadStream(coverPath)) as ReadableStream;
  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": mime,
      "Cache-Control": "public, max-age=86400",
    },
  });
};
