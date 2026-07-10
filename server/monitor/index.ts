/**
 * Go 监控 sidecar 管理
 *
 * 启动 / 停止 / 日志管道
 * 仅在 SPLAYER_MONITOR_ENABLED=true 且二进制存在时生效。
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { serverLog } from "@main/utils/logger";

const BIN_PATH = process.env.SPLAYER_MONITOR_BIN ?? resolve(import.meta.dirname, "..", "bin", "splayer-monitor");
const MONITOR_PORT = process.env.SPLAYER_MONITOR_PORT ?? "14559";
const ADMIN_BASE = `http://127.0.0.1:${MONITOR_PORT}`;

let proc: ChildProcess | null = null;
let stdin: NodeJS.WritableStream | null = null;
let started = false;

/** 是否启用 sidecar */
function isEnabled(): boolean {
  return process.env.SPLAYER_MONITOR_ENABLED === "true" && existsSync(BIN_PATH);
}

/** 启动 Go sidecar */
export function startMonitor(): void {
  if (!isEnabled()) {
    serverLog.info("[monitor] 未启用（SPLAYER_MONITOR_ENABLED=false 或二进制不存在）");
    return;
  }

  try {
    proc = spawn(BIN_PATH, [], {
      stdio: ["pipe", "ignore", "pipe"],
      env: { ...process.env, MONITOR_PORT },
    });

    stdin = proc.stdin;
    started = true;
    serverLog.info(`[monitor] sidecar 已启动 (PID ${proc.pid}, port ${MONITOR_PORT})`);

    proc.on("exit", (code, sig) => {
      serverLog.warn(`[monitor] sidecar 退出 (code=${code}, signal=${sig})`);
      proc = null;
      stdin = null;
      started = false;
    });

    proc.on("error", (err) => {
      serverLog.error(`[monitor] sidecar 启动失败: ${err.message}`);
      proc = null;
      stdin = null;
      started = false;
    });

    // 转发 stderr 到服务端日志
    proc.stderr?.on("data", (chunk: Buffer) => {
      for (const line of chunk.toString().split("\n").filter(Boolean)) {
        serverLog.info(`[monitor] ${line}`);
      }
    });
  } catch (err) {
    serverLog.error(`[monitor] 启动异常: ${err}`);
  }
}

/** 停止 Go sidecar */
export function stopMonitor(): void {
  if (proc) {
    proc.kill("SIGTERM");
    proc = null;
    stdin = null;
    started = false;
    serverLog.info("[monitor] sidecar 已停止");
  }
}

/** 写入日志行到 sidecar 的 stdin */
export function writeMonitorLog(line: string): void {
  if (stdin && started) {
    try {
      stdin.write(line + "\n");
    } catch {
      // sidecar 已退出，忽略
    }
  }
}

/** inline 日志捕获：替换 console.log/debug/error/warn 以写入 sidecar */
export function patchConsole(): void {
  if (!isEnabled()) return;

  const orig = {
    log: console.log,
    debug: console.debug,
    error: console.error,
    warn: console.warn,
  };

  // 写入 sidecar 前加 [LEVEL] 前缀
  console.log = (...args: unknown[]) => {
    writeMonitorLog(`[INFO] ${args.map(String).join(" ")}`);
    orig.log(...args);
  };
  console.debug = (...args: unknown[]) => {
    writeMonitorLog(`[DEBUG] ${args.map(String).join(" ")}`);
    orig.debug(...args);
  };
  console.error = (...args: unknown[]) => {
    writeMonitorLog(`[ERROR] ${args.map(String).join(" ")}`);
    orig.error(...args);
  };
  console.warn = (...args: unknown[]) => {
    writeMonitorLog(`[WARN] ${args.map(String).join(" ")}`);
    orig.warn(...args);
  };
}

/** 获取 Go sidecar 的 base URL（供 admin 路由代理用） */
export function getAdminBase(): string {
  return ADMIN_BASE;
}

/** 检查 sidecar 是否在运行 */
export function isMonitorRunning(): boolean {
  return started && proc !== null;
}
