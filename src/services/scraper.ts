/**
 * 刮削器 API 封装
 *
 * 提供刮削任务的启动、取消、进度查询等接口。
 * 仅在 Web 服务端模式下使用，Electron 桌面模式走 IPC。
 */

export interface ScrapeProgress {
  scraping: boolean;
  total: number;
  scraped: number;
  success?: number;
  failed?: number;
  skipped?: number;
  notFound?: number;
  canceled: boolean;
  /** 整理阶段标记（刮削完成后整理文件时置 true，结束后置 false） */
  organizing?: boolean;
  /** 整理阶段文件总数 */
  organizeTotal?: number;
  /** 整理阶段已处理文件数 */
  organizeDone?: number;
}

export interface ScrapeQueueItem {
  track_id: string;
  status: string;
  retries: number;
  last_error: string | null;
}

export interface OrganizeResult {
  total: number;
  moved: number;
  skipped: number;
  failed: number;
}

export interface StartScrapeResult {
  ok: boolean;
  dirs?: string[];
  progress?: ScrapeProgress;
}

const json = async <T>(res: Response): Promise<T> => {
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `HTTP ${res.status}`);
  }
  return (await res.json()) as T;
};

export const scraperApi = {
  /** 启动刮削任务
   * @param mode 运行模式 once | daemon
   * @param dirs 刮削目录列表（目录扫描模式）。为空时回退到 DB 队列模式或配置中的 scrapeDirs
   */
  async start(mode: "once" | "daemon" = "once", dirs?: string[]): Promise<StartScrapeResult> {
    return json(
      await fetch("/api/scraper/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode, dirs }),
      }),
    );
  },

  /** 取消刮削任务 */
  async cancel(): Promise<{ ok: boolean }> {
    return json(
      await fetch("/api/scraper/cancel", {
        method: "POST",
      }),
    );
  },

  /** 获取刮削进度 */
  async getProgress(): Promise<ScrapeProgress> {
    return json(await fetch("/api/scraper/progress"));
  },

  /** 获取待刮削队列 */
  async getQueue(): Promise<{ ok: boolean; queue: ScrapeQueueItem[] }> {
    return json(await fetch("/api/scraper/queue"));
  },

  /**
   * 纯整理模式：只整理文件不刮削
   * 适用于已经刮削完成、标签信息完善的媒体文件
   */
  async organize(
    sourceDirs?: string[],
    targetDir?: string,
    pattern?: string,
  ): Promise<{ ok: boolean; error?: string; result?: OrganizeResult }> {
    return json(
      await fetch("/api/scraper/organize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          dirs: sourceDirs,
          targetDir,
          pattern,
        }),
      }),
    );
  },
};
