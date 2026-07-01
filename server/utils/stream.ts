/**
 * 音频流 Range 响应服务
 *
 * 支持 HTTP Range 请求的音频文件流式响应，统一 serveTrackStream（music/serve.ts）
 * 和 Subsonic serveStream（routes/subsonic/helpers.ts）的相同逻辑。
 */

import { createReadStream, statSync } from "node:fs";
import { Readable } from "node:stream";
import path from "node:path";
import type { Context } from "hono";

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
 *
 * @param c         Hono Context
 * @param filePath  音频文件绝对路径
 * @param asDownload 是否强制下载（Content-Disposition: attachment）
 * @returns Response（200 / 206 / 416）
 */
export const serveAudioStream = (c: Context, filePath: string, asDownload = false): Response => {
  const st = statSync(filePath);
  const total = st.size;
  const mime = mimeOf(filePath);
  const rangeHeader = c.req.header("range");

  if (!rangeHeader || asDownload) {
    const stream = Readable.toWeb(createReadStream(filePath)) as ReadableStream;
    const headers: Record<string, string> = {
      "Content-Type": mime,
      "Content-Length": String(total),
      "Accept-Ranges": "bytes",
      "Cache-Control": "public, max-age=3600",
    };
    if (asDownload) {
      headers["Content-Disposition"] = `attachment; filename="${path.basename(filePath)}"`;
    }
    return new Response(stream, { status: 200, headers });
  }

  const m = /bytes=(\d*)-(\d*)/.exec(rangeHeader);
  if (!m) return c.body("invalid range", 416);
  const start = m[1] ? parseInt(m[1], 10) : 0;
  const end = m[2] ? parseInt(m[2], 10) : total - 1;
  if (start > end || start >= total) {
    return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${total}` } });
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
