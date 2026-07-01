import { serverLog } from "./logger";

const MONITOR_INTERVAL_MS = 2 * 60 * 1000;

let monitorTimer: NodeJS.Timeout | null = null;

/**
 * 内存监控器（纯监控，不干预）
 * 
 * V8 通过 --max-old-space-size 自动管理内存归还：
 * - 老生代接近上限时，V8 自动做增量压缩 + munmap 空闲页还给 OS
 * - 无需手动 global.gc()，避免阻塞事件循环
 */
export const startMemoryManager = (): void => {
  if (monitorTimer) return;

  monitorTimer = setInterval(() => {
    const usage = process.memoryUsage();
    const rssMb = Math.round(usage.rss / 1024 / 1024);
    const heapUsedMb = Math.round(usage.heapUsed / 1024 / 1024);
    const heapTotalMb = Math.round(usage.heapTotal / 1024 / 1024);
    const externalMb = Math.round(usage.external / 1024 / 1024);

    const heapUtilization = heapTotalMb > 0 ? heapUsedMb / heapTotalMb : 1;

    serverLog.debug(
      `[memory] rss=${rssMb}MB heap=${heapUsedMb}/${heapTotalMb}MB ` +
        `ext=${externalMb}MB util=${Math.round(heapUtilization * 100)}%`,
    );
  }, MONITOR_INTERVAL_MS);

  monitorTimer.unref?.();
};

export const stopMemoryManager = (): void => {
  if (monitorTimer) {
    clearInterval(monitorTimer);
    monitorTimer = null;
  }
};
