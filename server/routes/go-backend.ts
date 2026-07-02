/**
 * Go Subsonic 后端进程管理器
 *
 * SPlayer 服务端模式下，通过 spawn / kill 控制 Go Subsonic 子进程的生命周期。
 * 支持启动 / 停止 / 状态查询，适配 Web GUI 的开关控制。
 */
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { serverLog } from "@main/utils/logger";
import { databaseDir } from "@main/utils/paths";

/** Go 后端二进制路径，可通过环境变量覆盖 */
const GO_BACKEND_BIN = process.env.SUBSONIC_GO_BIN ?? "/app/bin/subsonic-go";

/** 监听端口 */
const GO_PORT = process.env.SUBSONIC_GO_PORT ?? "8081";

/** TS 服务端自身地址（Go 回调在线歌词注入需要） */
const TS_BASE = process.env.SUBSONIC_TS_URL ?? "http://127.0.0.1:8080";

let child: ChildProcess | null = null;
let startTime = 0;

/** 检查 Go 后端是否正在运行 */
export const isRunning = (): boolean => {
  if (!child) return false;
  try {
    return child.exitCode === null && !child.killed;
  } catch {
    return false;
  }
};

/** 获取 Go 后端 pid（未运行返回 null） */
export const getPid = (): number | null => (isRunning() && child?.pid ? child.pid : null);

/** 获取启动时间戳 */
export const getStartTime = (): number => (isRunning() ? startTime : 0);

/** 健康检查（仅日志，不影响启动流程） */
const healthCheck = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 2000);
      const resp = await fetch(`http://127.0.0.1:${GO_PORT}/rest/ping.view?u=p&p=p&v=1.16.1&c=splayer-probe&f=json`, {
        signal: ctrl.signal,
      });
      clearTimeout(timer);
      if (resp.ok || resp.status === 200) {
        serverLog.info("[go-backend] 健康检查通过");
        return;
      }
    } catch {
      // 未就绪继续等
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  serverLog.warn("[go-backend] 健康检查未通过（进程可能还在初始化）");
};

/** 启动 Go Subsonic 后端 */
export const start = async (): Promise<void> => {
  if (isRunning()) {
    serverLog.warn("[go-backend] 已在运行中，跳过启动");
    return;
  }

  return new Promise((resolve, reject) => {
    const dbPath = process.env.SPLAYER_DB_PATH ?? path.join(databaseDir, "library.db");

    child = spawn(GO_BACKEND_BIN, [], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      env: {
        ...process.env,
        SPLAYER_DB_PATH: dbPath,
        SUBSONIC_PORT: GO_PORT,
        SUBSONIC_TS_URL: TS_BASE,
      },
    });

    startTime = Date.now();
    let started = false;

    const onStdout = (data: Buffer): void => {
      const text = data.toString();
      serverLog.info(`[go-backend] ${text.trim()}`);
      if (!started && text.includes("监听")) {
        started = true;
        // 日志确认"监听"即 resolve，健康检查后台异步执行
        resolve();
        healthCheck();
      }
    };

    const onStderr = (data: Buffer): void => {
      const text = data.toString();
      serverLog.warn(`[go-backend] ${text.trim()}`);
      // Go log.Printf 默认写 stderr，确认"监听"标记启动
      if (!started && text.includes("监听")) {
        started = true;
        resolve();
        healthCheck();
      }
    };

    const onError = (err: Error): void => {
      serverLog.error(`[go-backend] 启动失败: ${err.message}`);
      child = null;
      if (!started) reject(err);
    };

    const onExit = (code: number | null, signal: string | null): void => {
      serverLog.info(`[go-backend] 已退出: code=${code} signal=${signal}`);
      child = null;
      if (!started) {
        reject(new Error(`Go backend exited prematurely (code=${code} signal=${signal})`));
      }
    };

    child.stdout?.on("data", onStdout);
    child.stderr?.on("data", onStderr);
    child.on("error", onError);
    child.on("exit", onExit);

    // 超时保护：10 秒后仍未监听到"监听"则判定启动失败
    setTimeout(() => {
      if (!started) {
        serverLog.warn("[go-backend] 10s 超时未就绪，强制终止");
        const proc = child;
        child = null;
        proc?.kill("SIGTERM");
        reject(new Error("Go backend 启动超时（10s）"));
      }
    }, 10_000);
  });
};

/** 停止 Go Subsonic 后端（发信号即返回，不阻塞） */
export const stop = async (): Promise<void> => {
  if (!isRunning()) {
    serverLog.warn("[go-backend] 未在运行，跳过停止");
    return;
  }

  serverLog.info("[go-backend] 发送 SIGTERM");
  const proc = child;
  proc?.kill("SIGTERM");

  // 5s 后 SIGTERM 未退出则强制 SIGKILL
  setTimeout(() => {
    if (proc && (proc.exitCode === null && !proc.killed)) {
      serverLog.warn("[go-backend] SIGTERM 未退出，发送 SIGKILL");
      proc.kill("SIGKILL");
    }
  }, 5_000).unref();

  // 标记已停止（后续 on("exit") 会设 child=null，refresh() 看到实际状态）
  child = null;
};

/** 完整状态 */
export const getStatus = (): { running: boolean; pid: number | null; startTime: number } => ({
  running: isRunning(),
  pid: getPid(),
  startTime: getStartTime(),
});
