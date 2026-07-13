/**
 * 音频转码流路由
 *
 * GET /api/audio/stream/:id?bitrate=128
 *
 * 通过服务端 C 音频引擎将任意格式音频转码为 OGG/Opus 流。
 * 浏览器端 <audio> 直接播放，无需浏览器端解码/处理。
 *
 * Phase 3: 交互模式 — stdin JSON 控制 + FFT WebSocket 旁路推送
 *
 * 与 /api/music/stream/:id 的区别：
 *   - /api/music/stream/:id  → 原始文件流（浏览器端解码 + EQ + 响度归一化）
 *   - /api/audio/stream/:id  → 服务端转码 OGG/Opus（服务端处理，浏览器纯播放）
 */
import { Hono } from "hono";
import { Readable } from "node:stream";
import { existsSync } from "node:fs";
import { getTracksByIds } from "@main/database";
import { spawnAudioEngine, getOrCreateInteractiveEngine, isAudioEngineAvailable } from "@main/audio-engine/binding";
import { getWebSocketServer, broadcastToStream } from "@main/routes/ws";
import { serverLog } from "@main/utils/logger";

const app = new Hono();

/**
 * GET /stream/:id — 转码音频流
 */
app.get("/stream/:id", (c) => {
  if (!isAudioEngineAvailable()) {
    return c.json({ error: "audio engine not available" }, 503);
  }

  const id = c.req.param("id");
  const track = getTracksByIds([id])[0];
  if (!track?.path || !existsSync(track.path)) {
    return c.json({ error: "track not found" }, 404);
  }

  // 解析查询参数
  const bitrateKbps = parseInt(c.req.query("bitrate") ?? "128", 10);
  const channels = parseInt(c.req.query("channels") ?? "2", 10);
  const offsetMs = parseInt(c.req.query("offset") ?? "0", 10);
  const bitrate = Math.max(32, Math.min(512, bitrateKbps)) * 1000;

  const audioPath = track.cueAudioPath ?? track.path;
  const seekOffset = track.cueStartMs ?? offsetMs;

  // Phase 2: 音频处理参数
  const eqStr = c.req.query("eq");
  const eqGains = eqStr ? eqStr.split(",").map(parseFloat).filter((n) => !isNaN(n)) : undefined;
  const eqPreampDb = parseFloat(c.req.query("preamp") ?? "0");
  const normalization = c.req.query("norm") === "1";
  const normalizationGain = parseFloat(c.req.query("normgain") ?? "0");
  const limiterEnabled = c.req.query("nolimiter") !== "1";
  const limiterThresholdDb = parseFloat(c.req.query("lthresh") ?? "-1.0");
  const fftEnabled = c.req.query("fft") === "1";
  const fftSize = parseInt(c.req.query("fftsize") ?? "1024", 10);

  serverLog.debug(
    `[audio] 转码请求: id=${id} bitrate=${bitrate / 1000}kbps ch=${channels}` +
    ` offset=${seekOffset}ms path=${audioPath}`,
  );

  try {
    const engineOptions = {
      bitrate,
      channels,
      offsetMs: seekOffset,
      eqGains,
      eqPreampDb,
      normalization,
      normalizationGain,
      limiterEnabled,
      limiterThresholdDb,
      fftEnabled,
      fftSize,
    };

    let child: ReturnType<typeof spawnAudioEngine>;

    // Phase 3: FFT 启用时使用交互模式，FFT 数据通过 WebSocket 推送
    if (fftEnabled) {
      const engine = getOrCreateInteractiveEngine(id, audioPath, engineOptions);
      child = engine.start(audioPath, engineOptions);

      // FFT 数据 → WebSocket 广播
      engine.on("fft", (msg: { bins: number; data: number[] }) => {
        broadcastToStream(id, { type: "audio:fft", data: msg });
      });
    } else {
      child = spawnAudioEngine(audioPath, engineOptions);
    }

    // 客户端断开或 C 引擎退出时清理
    let killed = false;
    const onAbort = (): void => {
      if (killed) return;
      killed = true;
      serverLog.debug(`[audio] 客户端断开，终止转码: id=${id}`);
      child.kill("SIGTERM");
      // SIGTERM 后 3 秒内未退出 → SIGKILL 强制 kill
      // FFmpeg 解码器阻塞在 av_read_frame() 磁盘 I/O 时
      // SIGTERM 信号可能被子进程忽略，只有 SIGKILL 能终止
      const timeout = setTimeout(() => {
        if (!child.killed) {
          serverLog.warn(`[audio] SIGTERM 未退出，强制 SIGKILL: id=${id}`);
          child.kill("SIGKILL");
        }
      }, 3000);
      child.once("exit", () => clearTimeout(timeout));
    };
    c.req.raw.signal?.addEventListener("abort", onAbort);

    // C 引擎自然退出 → 移除 abort listener 以防止闭包泄漏
    child.on("exit", () => {
      c.req.raw.signal?.removeEventListener("abort", onAbort);
    });

    const stream = Readable.toWeb(child.stdout) as ReadableStream;

    return new Response(stream, {
      status: 200,
      headers: {
        "Content-Type": "audio/ogg; codecs=opus",
        "Transfer-Encoding": "chunked",
        "Cache-Control": "no-cache",
        "Accept-Ranges": "none",
      },
    });
  } catch (err) {
    serverLog.error(`[audio] 转码失败: ${err}`);
    return c.json({ error: "transcode failed" }, 500);
  }
});

/**
 * GET /status — 引擎状态
 */
app.get("/status", (c) => {
  return c.json({
    available: isAudioEngineAvailable(),
    format: "ogg/opus",
    defaultBitrate: 128000,
  });
});

/**
 * POST /control/:id — Phase 3 运行时控制
 *
 * 接受 JSON: { type: "set_eq", gains: [0,0,...], preamp: 0 }
 * 用于运行时调整当前播放流的 EQ/音量等参数
 */
app.post("/control/:id", async (c) => {
  const id = c.req.param("id");
  const { getOrCreateInteractiveEngine } = await import("@main/audio-engine/binding");
  const engine = getOrCreateInteractiveEngine(id, "", {}); // 仅获取已有实例

  if (!engine.isActive) {
    return c.json({ error: "no active stream for this id" }, 404);
  }

  try {
    const body = await c.req.json();
    engine.send(body);
    return c.json({ ok: true });
  } catch (err) {
    return c.json({ error: "invalid control command" }, 400);
  }
});

export default app;
