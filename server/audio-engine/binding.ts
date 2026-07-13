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
  private controlBuf = "";
  private fftBuf = "";

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

    // fd 3: control protocol（手动行分割，无 readline 轮询）
    if (this.child.stdio[3]) {
      this.controlActive = true;
      (this.child.stdio[3] as NodeJS.ReadableStream).on("data", (chunk: Buffer) => {
        this.controlActive = true;
        this.controlBuf += chunk.toString();
        let idx: number;
        while ((idx = this.controlBuf.indexOf("\n")) !== -1) {
          const line = this.controlBuf.slice(0, idx);
          this.controlBuf = this.controlBuf.slice(idx + 1);
          try {
            const msg = JSON.parse(line) as EngineControlEvent;
            this.emit(msg.type, msg);
          } catch {
            serverLog.warn(`[audio-engine:interactive] 无效控制响应: ${line}`);
          }
        }
      });
      (this.child.stdio[3] as NodeJS.ReadableStream).on("end", () => {
        this.controlActive = false;
        this.controlBuf = "";
      });
    }

    // fd 4: FFT data（手动行分割，无 readline 轮询）
    if (this.child.stdio[4]) {
      (this.child.stdio[4] as NodeJS.ReadableStream).on("data", (chunk: Buffer) => {
        this.fftBuf += chunk.toString();
        let idx: number;
        while ((idx = this.fftBuf.indexOf("\n")) !== -1) {
          const line = this.fftBuf.slice(0, idx);
          this.fftBuf = this.fftBuf.slice(idx + 1);
          try {
            this.emit("fft", JSON.parse(line) as EngineControlEvent);
          } catch {
            /* 忽略无效 FFT 行 */
          }
        }
      });
      (this.child.stdio[4] as NodeJS.ReadableStream).on("end", () => {
        this.fftBuf = "";
      });
    }

    this.child.on("error", (err) => {
      this.controlActive = false;
      serverLog.error(`[audio-engine:interactive] 子进程错误: ${err.message}`);
    });

    this.child.on("exit", (code, signal) => {
      if (stderrBuffer.trim()) serverLog.debug(`[audio-engine:interactive:stderr] ${stderrBuffer.trim()}`);
      this.controlActive = false;
      this.controlBuf = "";
      this.fftBuf = "";
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
    }
    this.controlActive = false;
  }

  /** 引擎是否活跃 */
  get isActive(): boolean {
    return this.controlActive;
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
