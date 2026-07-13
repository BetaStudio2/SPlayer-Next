/**
 * audio-engine/binding.ts — C 音频引擎的 TypeScript 封装
 *
 * 通过子进程调用 splayer-audio-engine 二进制，将任意音频格式
 * 转码为 OGG/Opus 流。stdout 管道直出给 HTTP Response。
 *
 * Phase 3: 支持交互模式（--interactive），通过 control fd 收发 JSON 控制消息，
 *          通过 fft fd 接收 FFT 频谱数据。
 *
 * 用法（批量）：
 *   const child = spawnAudioEngine(filePath, { bitrate: 128000 });
 *   child.stdout.pipe(responseStream);
 *
 * 用法（交互）：
 *   const engine = spawnInteractiveEngine(filePath, options);
 *   engine.stdout.pipe(response);  // OGG Opus 流
 *   engine.send({ type: "set_eq", gains: [0,1,0,-1,...], preamp: 0 });
 *   engine.on("fft", (data) => { ... });  // FFT 频谱
 *   engine.on("status", (data) => { ... });  // 播放位置
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";
import { createInterface } from "node:readline";
import { serverLog } from "@main/utils/logger";

/** 引擎配置 */
export interface AudioEngineOptions {
  bitrate?: number;
  frameSizeMs?: number;
  channels?: number;
  offsetMs?: number;

  // Phase 2: 音频处理
  eqGains?: number[];
  eqPreampDb?: number;
  normalization?: boolean;
  normalizationGain?: number;
  limiterEnabled?: boolean;
  limiterThresholdDb?: number;
  fftEnabled?: boolean;
  fftSize?: number;

  // Phase 3: 交互模式
  interactive?: boolean;
  fftIntervalMs?: number;
}

const DEFAULT_OPTIONS: Required<AudioEngineOptions> = {
  bitrate: 128000,
  frameSizeMs: 20,
  channels: 2,
  offsetMs: 0,
  eqGains: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  eqPreampDb: 0,
  normalization: false,
  normalizationGain: 0,
  limiterEnabled: true,
  limiterThresholdDb: -1.0,
  fftEnabled: false,
  fftSize: 1024,
  interactive: false,
  fftIntervalMs: 100,
};

/**
 * 查找 splayer-audio-engine 二进制路径
 */
const findBinary = (): string => {
  const envPath = process.env.SPLAYER_AUDIO_ENGINE;
  if (envPath && existsSync(envPath)) return envPath;

  const devPath = path.join(process.cwd(), "audio-engine", "build", "splayer-audio-engine");
  if (existsSync(devPath)) return devPath;

  const dockerPath = "/app/bin/splayer-audio-engine";
  if (existsSync(dockerPath)) return dockerPath;

  return "splayer-audio-engine";
};

let binaryPath: string | null = null;

export const getBinaryPath = (): string => {
  if (binaryPath) return binaryPath;
  binaryPath = findBinary();
  return binaryPath;
};

export const isAudioEngineAvailable = (): boolean => {
  const bin = getBinaryPath();
  if (bin === "splayer-audio-engine") return true;
  return existsSync(bin);
};

/** 构建 CLI 参数 */
const buildArgs = (filePath: string, options: AudioEngineOptions): string[] => {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const args = [
    filePath,
    "--bitrate", String(opts.bitrate),
    "--frame-size", String(opts.frameSizeMs),
    "--channels", String(opts.channels),
  ];
  if (opts.offsetMs > 0) args.push("--offset", String(opts.offsetMs));

  // Phase 2
  if (opts.eqGains && opts.eqGains.length === 10) args.push("--eq", opts.eqGains.join(","));
  if (opts.eqPreampDb !== 0) args.push("--preamp", String(opts.eqPreampDb));
  if (opts.normalization) {
    args.push("--normalization");
    if (opts.normalizationGain !== 0) args.push("--normalization-gain", String(opts.normalizationGain));
  }
  if (!opts.limiterEnabled) args.push("--no-limiter");
  else if (opts.limiterThresholdDb !== -1.0) args.push("--limiter-threshold", String(opts.limiterThresholdDb));
  if (opts.fftEnabled) {
    args.push("--fft");
    if (opts.fftSize !== 1024) args.push("--fft-size", String(opts.fftSize));
  }

  // Phase 3
  if (opts.interactive) {
    args.push("--interactive", "--control-fd", "3");
    if (opts.fftEnabled) {
      args.push("--fft-fd", "4");
      if (opts.fftIntervalMs !== 100) args.push("--fft-interval-ms", String(opts.fftIntervalMs));
    }
  }

  return args;
};

/**
 * 启动音频引擎子进程（批量模式）
 */
export const spawnAudioEngine = (
  filePath: string,
  options: AudioEngineOptions = {},
): ChildProcessWithoutNullStreams => {
  const bin = getBinaryPath();
  const args = buildArgs(filePath, options);
  serverLog.debug(`[audio-engine] spawn: ${bin} ${args.join(" ")}`);

  const child = spawn(bin, args, {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });

  // stderr 实时转发日志（不缓存，C 引擎自行管理输出）
  child.stderr.on("data", (chunk: Buffer) => {
    for (const line of chunk.toString().split("\n").filter(Boolean)) {
      serverLog.debug(`[audio-engine:stderr] ${line}`);
    }
  });

  child.on("error", (err) => serverLog.error(`[audio-engine] 子进程错误: ${err.message}`));
  child.on("exit", (code, signal) => {
    // C 引擎已自行清理，TS 只需释放引用以便 V8 GC
    child.stdout?.removeAllListeners();
    child.stderr?.removeAllListeners();
    child.removeAllListeners();
  });

  child.on("close", () => {
    // pipe 全关闭后主动释放 stdin/stdout/stderr 引用链
    // Readable.toWeb(child.stdout) 在 Response 端会锚住 Readable，
    // 但主动 destroy 能加速 V8 发现不可达路径
    child.stdout?.destroy();
    child.stderr?.destroy();
    child.stdin?.destroy();
  });

  return child;
};

// ── Phase 3: 交互模式 ────────────────────────────────────────────

/** 控制命令 */
export interface EngineCommand {
  type: "set_eq";
  gains?: number[];
  preamp?: number;
}

export interface SetVolumeCommand {
  type: "set_volume";
  gain: number;
}

export interface SetBoolCommand {
  type: "set_normalization" | "set_limiter" | "set_fft";
  enabled: boolean;
}

export interface GetStatusCommand {
  type: "get_status";
}

export type ControlCommand = EngineCommand | SetVolumeCommand | SetBoolCommand | GetStatusCommand;

/** 控制响应 */
export interface EngineControlEvent {
  type: string;
  [key: string]: unknown;
}

/** 交互式引擎实例 */
export class InteractiveAudioEngine extends EventEmitter {
  private child: ChildProcessWithoutNullStreams | null = null;
  private controlActive = false;
  private controlRl: ReturnType<typeof createInterface> | null = null;
  private fftRl: ReturnType<typeof createInterface> | null = null;
  private exitTimeout: ReturnType<typeof setTimeout> | null = null;

  /**
   * 启动交互式引擎
   */
  start(filePath: string, options: AudioEngineOptions = {}): ChildProcessWithoutNullStreams {
    if (this.child) throw new Error("Engine already started");

    const bin = getBinaryPath();
    const opts = { ...options, interactive: true };
    const args = buildArgs(filePath, opts);
    serverLog.debug(`[audio-engine:interactive] spawn: ${bin} ${args.join(" ")}`);

    this.child = spawn(bin, args, {
      stdio: ["pipe", "pipe", "pipe", "pipe", "pipe"],
      windowsHide: true,
    });

    // stderr 实时转发日志（不缓存）
    let stderrBuffer = "";
    this.child.stderr.on("data", (chunk: Buffer) => {
      stderrBuffer += chunk.toString();
      const lines = stderrBuffer.split("\n");
      stderrBuffer = lines.pop() ?? "";
      for (const line of lines) {
        if (line.trim()) serverLog.debug(`[audio-engine:interactive:stderr] ${line.trim()}`);
      }
    });

    // fd 3: control protocol
    if (this.child.stdio[3]) {
      this.controlRl = createInterface({ input: this.child.stdio[3] as NodeJS.ReadableStream });
      this.controlActive = true;
      this.controlRl.on("line", (line: string) => {
        this.controlActive = true;
        try {
          const msg = JSON.parse(line) as EngineControlEvent;
          this.emit(msg.type, msg);
        } catch {
          serverLog.warn(`[audio-engine:interactive] 无效控制响应: ${line}`);
        }
      });
      this.controlRl.on("close", () => { this.controlActive = false; this.controlRl = null; });
    }

    // fd 4: FFT data
    if (this.child.stdio[4]) {
      this.fftRl = createInterface({ input: this.child.stdio[4] as NodeJS.ReadableStream });
      this.fftRl.on("line", (line: string) => {
        try {
          const msg = JSON.parse(line) as EngineControlEvent;
          this.emit("fft", msg);
        } catch {
          /* 忽略无效的 FFT 行 */
        }
      });
    }

    this.child.on("error", (err) => {
      this.controlActive = false;
      serverLog.error(`[audio-engine:interactive] 子进程错误: ${err.message}`);
    });

    this.child.on("exit", (code, signal) => {
      if (stderrBuffer.trim()) serverLog.debug(`[audio-engine:interactive:stderr] ${stderrBuffer.trim()}`);
      this.controlActive = false;
      // 关闭 readline 接口：防止 readline 内部定时器在已关闭的 fd 上轮询
      this.controlRl?.close();
      this.controlRl = null;
      this.fftRl?.close();
      this.fftRl = null;
      this.clearExitTimeout();
      this.emit("exit", { code, signal });
      // C 引擎已自行清理，TS 只需释放引用以便 V8 GC
      if (this.child) {
        this.child.stdout?.removeAllListeners();
        this.child.stderr?.removeAllListeners();
        this.child.removeAllListeners();
        this.child = null;
      }
    });

    return this.child;
  }

  /** 发送控制命令 */
  send(cmd: ControlCommand): void {
    if (!this.child || !this.child.stdin || !this.controlActive) {
      serverLog.warn("[audio-engine:interactive] 无法发送命令：引擎未就绪");
      return;
    }
    try {
      const line = JSON.stringify(cmd) + "\n";
      this.child.stdin.write(line);
    } catch (err) {
      serverLog.error(`[audio-engine:interactive] 发送命令失败: ${err}`);
    }
  }

  /** 终止引擎 */
  kill(signal: NodeJS.Signals = "SIGTERM"): void {
    if (this.child && !this.child.killed) {
      this.child.kill(signal);
      if (signal === "SIGTERM") {
        // SIGTERM 后 3 秒内未退出 → SIGKILL 强制 kill
        // FFmpeg 解码器阻塞在 av_read_frame() 磁盘 I/O 时
        // SIGTERM 信号可能被子进程忽略，只有 SIGKILL 能终止
        this.exitTimeout = setTimeout(() => {
          if (this.child && !this.child.killed) {
            this.child.kill("SIGKILL");
          }
        }, 3000);
      }
    }
    this.controlActive = false;
  }

  /** 引擎是否活跃 */
  get isActive(): boolean {
    return this.controlActive;
  }

  private clearExitTimeout(): void {
    if (this.exitTimeout) {
      clearTimeout(this.exitTimeout);
      this.exitTimeout = null;
    }
  }

  /** 子进程 stdout（OGG/Opus 流） */
  get stdout(): NodeJS.ReadableStream | null {
    return this.child?.stdout ?? null;
  }
}

// ── 全局交互引擎管理（每个流一个实例） ──────────────────────────

const activeEngines = new Map<string, InteractiveAudioEngine>();

/** 获取或创建交互式引擎 */
export const getOrCreateInteractiveEngine = (key: string, filePath: string, options: AudioEngineOptions = {}): InteractiveAudioEngine => {
  const existing = activeEngines.get(key);
  if (existing?.isActive) return existing;

  // 清理旧实例
  if (existing) existing.kill();

  const engine = new InteractiveAudioEngine();
  engine.start(filePath, options);
  activeEngines.set(key, engine);

  // engine 结束时清理
  engine.on("exit", () => {
    if (activeEngines.get(key) === engine) {
      activeEngines.delete(key);
    }
  });

  return engine;
};
