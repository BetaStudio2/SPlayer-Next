/**
 * 刮削器 API 路由
 *
 * 提供刮削任务的启动、取消、进度查询等接口。
 * 实际刮削工作由 C++ 二进制 splayer-scraper 执行。
 *
 * 启动刮削时可以传入 dirs 参数指定独立的刮削目录：
 *   POST /start { mode: "once", dirs: ["/path/to/scrape"] }
 * 如果不传 dirs，则回退到 DB 队列模式。
 */
import { Hono } from "hono";
import { scrapeQueue, startScrape, cancelScrape, getScrapeProgress, startOrganize } from "@main/music/scraper";
import { libraryLog } from "@main/utils/logger";
import { store } from "@main/store";

const app = new Hono();

/** POST /start —— 启动刮削任务
 * body: { mode?: "once" | "daemon", dirs?: string[] }
 * dirs 为空时，自动读取配置中的 library.scrapeDirs
 */
app.post("/start", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const { mode = "once", dirs } = body as { mode?: "once" | "daemon"; dirs?: string[] };

  if (mode !== "once" && mode !== "daemon") {
    return c.json({ error: "invalid mode" }, 400);
  }

  // 优先使用请求中的 dirs，其次读取配置中的 scrapeDirs
  let scrapeDirs: string[] = [];
  if (Array.isArray(dirs)) {
    scrapeDirs = dirs.filter((d): d is string => typeof d === "string" && !!d.trim());
  }
  if (scrapeDirs.length === 0) {
    const configured = store.get("library.scrapeDirs") as string[] | undefined;
    if (Array.isArray(configured)) {
      scrapeDirs = configured.filter((d: unknown): d is string => typeof d === "string" && !!d.trim());
    }
  }

  libraryLog.info(`[scraper-api] 收到启动请求: mode=${mode}, dirs=${scrapeDirs.length} 个`);
  const started = await startScrape(mode, scrapeDirs);

  if (!started) {
    return c.json({ ok: false, error: "no valid scrape directories" }, 400);
  }

  return c.json({ ok: true, dirs: scrapeDirs });
});

/** POST /cancel —— 取消刮削任务 */
app.post("/cancel", (c) => {
  libraryLog.info("[scraper-api] 收到取消请求");
  cancelScrape();
  return c.json({ ok: true });
});

/** GET /progress —— 获取刮削进度 */
app.get("/progress", (c) => {
  return c.json(getScrapeProgress());
});

/** GET /queue —— 获取待刮削队列（DB 队列模式） */
app.get("/queue", (c) => {
  const queue = scrapeQueue.list();
  return c.json({ ok: true, queue });
});

/**
 * POST /organize —— 纯整理模式（不刮削）
 *
 * 适用于已经刮削完成、标签信息完善的媒体文件。
 * 直接从刮削目录移动到音乐库目录，跳过 C++ 刮削步骤。
 *
 * body: {
 *   dirs?: string[]        // 源目录（从何整理），默认读取 library.scrapeDirs
 *   targetDir?: string     // 目标根目录，默认读取 library.organizeTargetDir
 *   pattern?: string       // 整理模板，默认读取 library.organizePattern
 * }
 */
app.post("/organize", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const { dirs, targetDir: bodyTarget, pattern: bodyPattern } = body as {
    dirs?: string[];
    targetDir?: string;
    pattern?: string;
  };

  // 源目录：请求参数 > 配置
  let sourceDirs: string[] = [];
  if (Array.isArray(dirs)) {
    sourceDirs = dirs.filter((d): d is string => typeof d === "string" && !!d.trim());
  }
  if (sourceDirs.length === 0) {
    const configured = store.get("library.scrapeDirs") as string[] | undefined;
    if (Array.isArray(configured)) {
      sourceDirs = configured.filter((d: unknown): d is string => typeof d === "string" && !!d.trim());
    }
  }

  // 目标目录：请求参数 > 配置
  const targetDir = bodyTarget || (store.get("library.organizeTargetDir") as string) || "";

  // 模板：请求参数 > 配置 > 默认值
  const pattern = bodyPattern ||
    (store.get("library.organizePattern") as string) ||
    "{artist}/{album}/{track}. {title}.{ext}";

  libraryLog.info(
    `[scraper-api] 收到整理请求: dirs=${sourceDirs.length} 个, target=${targetDir}`,
  );

  if (sourceDirs.length === 0) {
    return c.json({ ok: false, error: "no valid source directories" }, 400);
  }

  const result = await startOrganize(sourceDirs, targetDir, pattern);

  if (!result.ok) {
    return c.json({ ok: false, error: result.error }, 400);
  }

  return c.json({
    ok: true,
    result: {
      total: result.result?.total ?? 0,
      moved: result.result?.moved ?? 0,
      skipped: result.result?.skipped ?? 0,
      failed: result.result?.failed ?? 0,
    },
  });
});

export default app;
