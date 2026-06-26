/**
 * 服务端日志 shim（替换 electron-log）
 *
 * 不落盘、只输出到控制台，保留与桌面端同名的作用域导出，
 * 使被复制的 apis/database/store 等模块无需修改即可引用。
 */

interface ScopedLogger {
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
  debug: (...args: unknown[]) => void;
  log: (...args: unknown[]) => void;
}

const createScope = (scope: string): ScopedLogger => {
  const prefix = `[${scope}]`;
  return {
    info: (...args) => console.log(prefix, ...args),
    warn: (...args) => console.warn(prefix, ...args),
    error: (...args) => console.error(prefix, ...args),
    debug: (...args) => console.debug(prefix, ...args),
    log: (...args) => console.log(prefix, ...args),
  };
};

/** 日志根目录（服务端不落盘，仅保留导出以兼容引用） */
export const logsDir = "";
export const nativeLogsDir = "";

/** 兼容桌面端 initLogger 调用，服务端无需初始化 */
export const initLogger = (): void => {
  console.log("[logger] server console logger ready");
};

export const coreLog = createScope("core");
export const playerLog = createScope("player");
export const mediaLog = createScope("media");
export const trayLog = createScope("tray");
export const thumbarLog = createScope("thumbar");
export const systemLog = createScope("system");
export const ipcLog = createScope("ipc");
export const libraryLog = createScope("library");
export const taskbarLog = createScope("taskbar-lyric");
export const nativeLog = createScope("native");
export const streamingLog = createScope("streaming");
export const songCacheLog = createScope("songCache");
export const downloadLog = createScope("download");
export const serverLog = createScope("server");
export const pluginLog = createScope("plugin");
export const lastfmLog = createScope("lastfm");
export const neteaseLog = createScope("netease");
export const updaterLog = createScope("updater");
export const cloudLog = createScope("cloud");
