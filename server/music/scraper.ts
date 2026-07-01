/**
 * 刮削器模块
 *
 * 负责调用 C++ 刮削器二进制，管理刮削进度
 * 
 * 工作模式：
 * 1. 目录扫描模式（推荐）：传入 scrapeDirs，C++ 直接扫描目录中的音频文件，
 *    使用 TagLib 读取现有标签作为查询基础，不依赖 DB tracks 表。
 *    适用于刮削目录不在扫描路径中的场景。
 * 2. DB 队列模式（兼容）：不传 dirs，从 DB scrape_queue 获取任务。
 * 
 * 刮削流程：
 * 1. C++ 刮削器扫描 scrapeDirs，读取音频文件现有标签（含 MBID/ISRC）
 * 2. 跳过已刮削文件（有 MusicBrainz MBID 或 ISRC 的文件）
 * 3. 从 MusicBrainz 查询元数据（标题/艺术家/专辑/作曲/编号等）
 * 4. 从 Cover Art Archive 获取封面
 * 5. 从 LRCLIB 获取歌词
 * 6. 使用 TagLib 将元数据/封面/歌词/MBID/ISRC 写入音频文件（覆盖）
 * 7. 通过 HTTP 代理更新 SQLite 数据库
 * 8. 刮削完成后，根据配置：
 *    - 若启用 organizeAfterScrape：按模板整理文件到音乐库目录，再扫描入库
 *    - 否则：直接扫描刮削目录入库
 */
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { getDb, getScraperDb } from "@main/database";
import { libraryLog } from "@main/utils/logger";
import { databaseDir } from "@main/utils/paths";
import { emit, type ScrapeProgress } from "@main/utils/events";
import { startScan } from "@main/music/scanner";
import { organizeDir, type OrganizeResult } from "@main/music/organizer";
import { store } from "@main/config/store";

/** 纯整理模式：是否正在整理（不刮削） */
let organizeActive = false;

const SCRAPER_BIN = process.env.SCRAPER_BIN || "/app/bin/splayer-scraper";
const API_URL = process.env.API_URL || "http://localhost:8080";
const PROXY_KEY = process.env.PROXY_KEY || "dev-proxy-key";

let child: ChildProcess | null = null;
let progress: ScrapeProgress = {
  scraping: false,
  total: 0,
  scraped: 0,
  success: 0,
  failed: 0,
  skipped: 0,
  notFound: 0,
  canceled: false,
};

/** 当前刮削使用的目录（用于完成后触发扫描） */
let currentScrapeDirs: string[] = [];

/**
 * 刮削队列管理（DB 队列模式用）
 */
export const scrapeQueue = {
  /**
   * 列出待刮削的曲目
   */
  list(): Array<{ track_id: string; status: string; retries: number; last_error: string | null }> {
    const db = getScraperDb();
    return db
      .prepare(
        `SELECT track_id, status, retries, last_error 
         FROM scrape_queue 
         WHERE status = 'pending' OR (status = 'failed' AND retries < 3)
         ORDER BY created_at ASC`
      )
      .all() as Array<{ track_id: string; status: string; retries: number; last_error: string | null }>;
  },

  /**
   * 更新刮削状态
   */
  update(trackId: string, status: "success" | "failed", error?: string): void {
    const db = getDb();
    if (status === "success") {
      db.prepare(
        `UPDATE scrape_queue SET status = 'success', updated_at = CURRENT_TIMESTAMP WHERE track_id = ?`
      ).run(trackId);
    } else {
      db.prepare(
        `UPDATE scrape_queue 
         SET status = 'failed', retries = retries + 1, last_error = ?, updated_at = CURRENT_TIMESTAMP 
         WHERE track_id = ?`
      ).run(error || null, trackId);
    }
  },
};

/**
 * 获取当前刮削进度
 */
export function getScrapeProgress(): ScrapeProgress {
  return { ...progress };
}

/**
 * Directory pre-check removed — C++ scanner handles empty dirs natively.
 * Duplicating the dir walk here added latency with no benefit.
 */

/**
 * 启动刮削
 * @param mode 运行模式 once | daemon
 * @param dirs 刮削目录列表（目录扫描模式）。为空时回退到 DB 队列模式
 * @returns 是否成功启动
 */
export async function startScrape(
  mode: "once" | "daemon" = "once",
  dirs: string[] = [],
): Promise<boolean> {
  if (child) {
    libraryLog.warn("[scraper] 刮削器已在运行");
    return false;
  }

  // 目录扫描模式：需要有目录
  // DB 队列模式：需要有队列
  if (dirs.length > 0) {
    currentScrapeDirs = [...dirs];
  } else {
    // 没有传递具体 dirs 时，检查配置中的刮削目录
    const configuredDirs = store.get("library.scrapeDirs") as string[] | undefined;
    if (Array.isArray(configuredDirs) && configuredDirs.length > 0) {
      currentScrapeDirs = [...configuredDirs];
    } else {
      // 连配置中也没有目录，拒绝启动
      libraryLog.warn("[scraper] 未设置刮削目录，无法启动");
      return false;
    }
  }

  // 二次校验：确保至少有一个有效目录
  const validDirs = currentScrapeDirs.filter((d) => d && d.trim());
  if (validDirs.length === 0) {
    libraryLog.warn("[scraper] 没有有效的刮削目录，无法启动");
    currentScrapeDirs = [];
    return false;
  }
  currentScrapeDirs = validDirs;

  // 立即设置进度并广播，不等 C++ 扫描（C++ 会通过 stderr 上报实际总数）
  // hasAnyAudioFile 已移除：重复目录遍历会增加数秒延迟，由 C++ 自行处理空目录
  progress = {
    scraping: true,
    total: 0,
    scraped: 0,
    success: 0,
    failed: 0,
    skipped: 0,
    notFound: 0,
    canceled: false,
  };
  emit({ type: "scrape:progress", data: progress });

  // 构建命令行参数
  const args: string[] = [mode];
  // 将目录作为参数传递给二进制刮削器
  if (currentScrapeDirs.length > 0) {
    args.push("--dirs", currentScrapeDirs.join(","));
    libraryLog.info(`[scraper] 启动目录扫描模式: mode=${mode}, 目录 ${currentScrapeDirs.length} 个`);
    for (const d of currentScrapeDirs) {
      libraryLog.info(`[scraper]   目录: ${d}`);
    }
  } else {
    // DB 队列模式（理论上当前代码逻辑不会走到这里）
    const queue = scrapeQueue.list();
    libraryLog.info(`[scraper] 启动 DB 队列模式: mode=${mode}, 待处理 ${queue.length} 首`);
  }

  child = spawn(SCRAPER_BIN, args, {
    env: {
      ...process.env,
      SPLAYER_API_URL: API_URL,
      PROXY_KEY,
      SCRAPER_SKIP_SCRAPED: store.get("library.skipScraped") ? "1" : "0",
      SCRAPER_USE_MUSICBRAINZ: store.get("library.useMusicBrainz") !== false ? "1" : "0",
      SCRAPER_USE_DEEZER: store.get("library.useDeezer") !== false ? "1" : "0",
      SCRAPER_USE_ITUNES: store.get("library.useItunes") !== false ? "1" : "0",
      // 中文音乐源：默认开启，与西方源互补
      SCRAPER_USE_NETEASE: store.get("library.useNetease") !== false ? "1" : "0",
      SCRAPER_USE_QQMUSIC: store.get("library.useQQMusic") !== false ? "1" : "0",
      SCRAPER_USE_KUGOU: store.get("library.useKugou") !== false ? "1" : "0",
      SCRAPER_USE_KUWO: store.get("library.useKuwo") !== false ? "1" : "0",
      SCRAPER_USE_MIGU: store.get("library.useMigu") !== false ? "1" : "0",
      SCRAPER_CONCURRENT_WORKERS: String(store.get("library.concurrentWorkers") || 4),
      SPLAYER_SCRAPER_DB_PATH: process.env.SPLAYER_SCRAPER_DB_PATH ?? path.join(databaseDir, "scraper-state.db"),
    },
  });

  let stdoutBuffer = "";

  child.stdout?.on("data", (data) => {
    stdoutBuffer += data.toString();
    const lines = stdoutBuffer.split("\n");
    stdoutBuffer = lines.pop() || "";

    for (const line of lines) {
      if (!line.trim()) continue;
      libraryLog.debug(`[scraper] stdout: ${line}`);
    }
  });

  let stderrBuffer = "";
  child.stderr?.on("data", (data) => {
    stderrBuffer += data.toString();
    const lines = stderrBuffer.split("\n");
    stderrBuffer = lines.pop() || "";

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line) continue;

      libraryLog.info(`[scraper] ${line}`);

      // 解析「取到 N 个待处理文件」——最早设置 total，避免前端 0/?
      // 同时兼容 DB 队列模式的 "取到 N 个待刮削项"
      const countMatch = line.match(/取到\s+(\d+)\s+个待处理文件/) || line.match(/取到\s+(\d+)\s+个待刮削项/);
      if (countMatch) {
        const total = parseInt(countMatch[1], 10);
        if (total > 0) {
          progress.total = total;
          emit({ type: "scrape:progress", data: progress });
        }
        continue;
      }

      // 解析「目录中无音频文件」—— C++ 端扫描发现空目录，正常结束
      // 注意：空目录属于正常完成，不应设置 canceled=true，否则前端状态卡住
      if (line.includes("目录中无音频文件")) {
        progress.scraping = false;
        emit({ type: "scrape:progress", data: progress });
        continue;
      }

      // 解析精确完成标记：[scraper] [done N/Total] status=success|failed|skipped|not_found
      // C++ 端每个文件处理完成后输出一次，作为进度更新的唯一依据
      const doneMatch = line.match(/\[done\s+(\d+)\/(\d+)\]\s+status=(\w+)/);
      if (doneMatch) {
        const current = parseInt(doneMatch[1], 10);
        const total = parseInt(doneMatch[2], 10);
        const status = doneMatch[3];
        if (total > 0) {
          progress.total = total;
          progress.scraped = Math.min(current, total);
        }
        switch (status) {
          case "success":  progress.success++; break;
          case "failed":   progress.failed++; break;
          case "skipped":  progress.skipped++; break;
          case "not_found": progress.notFound++; break;
        }
        emit({ type: "scrape:progress", data: progress });
        continue;
      }

      // 解析“开始处理第 N 个”提示：仅用于提前暴露 total，不增加 scraped
      // C++ 端输出格式：[scraper] [N/Total] artist - title (album)
      const progressMatch = line.match(/\[(\d+)\/(\d+)\]/);
      if (progressMatch) {
        const total = parseInt(progressMatch[2], 10);
        if (total > 0 && progress.total === 0) {
          progress.total = total;
          emit({ type: "scrape:progress", data: progress });
        }
      }
    }

    // 旧的 ✓ / ✗ 标记不再用于进度计数，避免一个文件触发多次 increment
    // （成功文件可能同时输出“封面/歌词/标签写入成功”等多个 ✓）
  });

  child.on("close", async (code) => {
    libraryLog.info(`[scraper] 刮削器退出: code=${code}`);
    child = null;
    progress.scraping = false;

    // 空目录（0 文件）属于正常完成，不应标记为 canceled
    // canceled 仅由用户主动调用 cancelScrape() 时设置
    if (progress.total === 0 && progress.scraped === 0) {
      libraryLog.info("[scraper] 未找到音频文件，正常结束");
    }

    emit({ type: "scrape:progress", data: progress });
    emit({
      type: "scrape:done",
      data: {
        total: progress.total,
        scraped: progress.scraped,
        success: progress.success,
        failed: progress.failed,
        skipped: progress.skipped,
        notFound: progress.notFound,
        canceled: progress.canceled,
      },
    });

    // 刮削成功完成后，根据配置决定是否整理文件，再触发扫描
    // 至少有一个文件刮削成功才触发后续整理/扫描
    if (code === 0 && currentScrapeDirs.length > 0 && progress.success > 0) {
      try {
        const organizeEnabled = store.get("library.organizeAfterScrape");
        const scanDirs = store.get("library.scanDirs");
        const organizeTargetDir = store.get("library.organizeTargetDir") || scanDirs[0] || "";

        let scanTargetDirs = currentScrapeDirs;

        if (organizeEnabled && organizeTargetDir) {
          // 整理文件：从刮削目录移动到音乐库目录
          const pattern = store.get("library.organizePattern");
          libraryLog.info(
            `[scraper] 刮削完成，开始整理文件到 ${organizeTargetDir} (模板: ${pattern})`,
          );

          // 查询 scraper-state.db：获取刮削失败/未找到匹配的文件路径
          // 这些 pending 文件应留在源目录等待下次重试，不整理入库
          let excludePaths: Set<string> = new Set();
          try {
            const scraperDb = getScraperDb();
            const pendingFiles = scraperDb
              .prepare(
                "SELECT track_id FROM scrape_queue WHERE status != 'success' AND status != 'skipped'",
              )
              .all() as Array<{ track_id: string }>;
            if (pendingFiles.length > 0) {
              excludePaths = new Set(pendingFiles.map((r) => r.track_id));
              libraryLog.info(
                `[scraper] 排除 ${excludePaths.size} 个刮削 pending 文件，不整理入库`,
              );
            }
          } catch (err) {
            libraryLog.warn("[scraper] 读取 scraper-state.db 失败，将整理全部文件:", err);
          }

          // 推送整理阶段进度到前端
          emit({
            type: "scrape:progress",
            data: { ...progress, organizing: true, organizeDone: 0, organizeTotal: 0 },
          });

          const result = await organizeDir(
            currentScrapeDirs,
            organizeTargetDir,
            pattern,
            (current, total) => {
              emit({
                type: "scrape:progress",
                data: {
                  ...progress,
                  organizing: true,
                  organizeDone: current,
                  organizeTotal: total,
                },
              });
            },
            excludePaths,
          );
          libraryLog.info(
            `[scraper] 整理完成: 移动 ${result.moved}, 跳过 ${result.skipped}, 失败 ${result.failed}`,
          );

          if (result.failed > 0) {
            for (const f of result.failures) {
              libraryLog.warn(`[scraper] 整理失败 ${f.file}: ${f.reason}`);
            }
          }

          // 整理阶段结束，清除 organizing 标记
          emit({
            type: "scrape:progress",
            data: { ...progress, organizing: false, organizeDone: 0, organizeTotal: 0 },
          });

          // 不清理空的源目录：保留现有文件夹结构，避免误删用户整理的目录

          // 整理后扫描音乐库目录（确保包含整理目标目录和已配置的扫描目录）
          scanTargetDirs = Array.from(new Set([...scanDirs, organizeTargetDir])).filter((d) => d);
        }

        libraryLog.info(`[scraper] 触发扫描器扫描目录以入库: ${scanTargetDirs.join(", ")}`);
        await startScan(scanTargetDirs, true);
      } catch (err) {
        libraryLog.error("[scraper] 刮削后处理失败:", err);
        // 回退：直接扫描刮削目录
        try {
          await startScan(currentScrapeDirs, true);
        } catch (scanErr) {
          libraryLog.error("[scraper] 触发扫描失败:", scanErr);
        }
      }
    }
  });

  child.on("error", (err) => {
    libraryLog.error(`[scraper] 启动失败:`, err);
    child = null;
    progress.scraping = false;
    progress.canceled = true;
    emit({ type: "scrape:progress", data: progress });
    emit({
      type: "scrape:done",
      data: {
        total: progress.total,
        scraped: progress.scraped,
        success: progress.success,
        failed: progress.failed,
        skipped: progress.skipped,
        notFound: progress.notFound,
        canceled: true,
      },
    });
  });

  return true;
}

/**
 * 取消刮削
 *
 * 流程：
 * 1. 立即释放 scrape_queue 中所有 running 任务回 pending（无 retry 惩罚）
 * 2. 发送 SIGTERM 让 C++ 侧优雅退出（剩余任务由引擎自行释放）
 * 3. 5 秒超时后 SIGKILL 强制终止（兜底）
 */
export function cancelScrape(): void {
  // 先检查进程是否还在运行：进程已退出时取消无意义
  // 同时清理可能残留的 canceled 标记，避免前端状态卡住
  if (!child) {
    if (progress.canceled) {
      progress.canceled = false;
      progress.scraping = false;
      emit({ type: "scrape:progress", data: progress });
      libraryLog.info("[scraper] 进程已退出，重置残留的 canceled 状态");
    } else {
      // 刮削器已正常退出，但前端可能因 WS 丢失而卡在"正在刮削"
      // 手动发送 scrape:done 确保前端状态同步
      libraryLog.info("[scraper] 刮削器已退出，发送终态事件同步前端状态");
      progress.scraping = false;
      emit({ type: "scrape:progress", data: progress });
      emit({
        type: "scrape:done",
        data: {
          total: progress.total,
          scraped: progress.scraped,
          success: progress.success,
          failed: progress.failed,
          skipped: progress.skipped,
          notFound: progress.notFound,
          canceled: progress.canceled,
        },
      });
    }
    return;
  }
  if (progress.canceled) {
    libraryLog.warn("[scraper] 取消已在进行中");
    return;
  }

  libraryLog.info("[scraper] 取消刮削");
  progress.canceled = true;
  emit({ type: "scrape:progress", data: progress });

  // 安全网：立即释放所有 running 任务回 pending
  // 即使 C++ 侧来不及优雅释放（如 SIGKILL 兜底），任务也不会丢失
  try {
    const db = getScraperDb();
    const released = db
      .prepare(
        "UPDATE scrape_queue SET status = 'pending', last_error = 'canceled', updated_at = ? WHERE status = 'running'",
      )
      .run(Date.now());
    if (released.changes > 0) {
      libraryLog.info(`[scraper] 安全网释放 ${released.changes} 个 running 任务`);
    }
  } catch (err) {
    libraryLog.error("[scraper] 释放 running 任务失败:", err);
  }

  child.kill("SIGTERM");

  setTimeout(() => {
    if (child) {
      libraryLog.warn("[scraper] 强制终止");
      child.kill("SIGKILL");
    }
  }, 5000);
}

/**
 * 纯整理模式：只整理文件不刮削
 *
 * 适用于已经刮削完成、标签信息完善的媒体文件，
 * 直接按模板从刮削目录移动到音乐库目录，跳过 C++ 刮削步骤。
 *
 * 流程：
 * 1. 扫描 sourceDirs 中的音频文件
 * 2. 读取每个文件的现有标签（不联网查询）
 * 3. 按 organizePattern 模板生成目标路径
 * 4. 移动文件到 organizeTargetDir（跨设备自动 copy+unlink）
 * 5. 触发扫描器扫描目标目录入库
 *
 * @param sourceDirs 源目录（从何整理）
 * @param targetDir 目标根目录（整理到哪里）
 * @param pattern 整理模板
 * @returns 整理结果
 */
export async function startOrganize(
  sourceDirs: string[],
  targetDir: string,
  pattern: string,
): Promise<{ ok: boolean; error?: string; result?: OrganizeResult }> {
  if (child) {
    return { ok: false, error: "刮削器正在运行，请等待刮削完成后再整理" };
  }
  if (organizeActive) {
    return { ok: false, error: "整理任务已在运行中" };
  }

  const validDirs = sourceDirs.filter((d) => d && d.trim());
  if (validDirs.length === 0) {
    return { ok: false, error: "没有有效的源目录" };
  }
  if (!targetDir || !targetDir.trim()) {
    return { ok: false, error: "未设置目标目录" };
  }
  if (!pattern || !pattern.trim()) {
    return { ok: false, error: "未设置整理模板" };
  }

  const scanDirs = store.get("library.scanDirs");

  organizeActive = true;

  // 重置进度状态（仅整理模式，scraping=false）
  const organizeProgress: ScrapeProgress = {
    scraping: false,
    total: 0,
    scraped: 0,
    success: 0,
    failed: 0,
    skipped: 0,
    notFound: 0,
    canceled: false,
    organizing: true,
    organizeDone: 0,
    organizeTotal: 0,
  };
  emit({ type: "scrape:progress", data: organizeProgress });

  try {
    libraryLog.info(
      `[organize] 开始纯整理: ${validDirs.join(", ")} -> ${targetDir} (模板: ${pattern})`,
    );

    const result = await organizeDir(
      validDirs,
      targetDir,
      pattern,
      (current, total, _file) => {
        organizeProgress.organizeTotal = total;
        organizeProgress.organizeDone = current;
        emit({ type: "scrape:progress", data: organizeProgress });
      },
    );

    libraryLog.info(
      `[organize] 整理完成: 移动 ${result.moved}, 跳过 ${result.skipped}, 失败 ${result.failed}`,
    );

    if (result.failed > 0) {
      for (const f of result.failures) {
        libraryLog.warn(`[organize] 整理失败 ${f.file}: ${f.reason}`);
      }
    }

    // 整理阶段结束
    organizeProgress.organizing = false;
    organizeProgress.organizeDone = 0;
    organizeProgress.organizeTotal = 0;
    emit({ type: "scrape:progress", data: organizeProgress });
    emit({
      type: "scrape:done",
      data: {
        total: organizeProgress.total,
        scraped: organizeProgress.scraped,
        success: organizeProgress.success,
        failed: organizeProgress.failed,
        skipped: organizeProgress.skipped,
        notFound: organizeProgress.notFound,
        canceled: false,
      },
    });

    // 整理后扫描音乐库目录
    const allScanDirs = Array.from(
      new Set([...(Array.isArray(scanDirs) ? scanDirs : []), targetDir]),
    ).filter((d) => d);
    libraryLog.info(`[organize] 触发扫描器扫描目录以入库: ${allScanDirs.join(", ")}`);
    await startScan(allScanDirs, true);

    organizeActive = false;
    return { ok: true, result };
  } catch (err) {
    organizeActive = false;
    const msg = err instanceof Error ? err.message : String(err);
    libraryLog.error("[organize] 整理失败:", err);

    organizeProgress.organizing = false;
    organizeProgress.canceled = true;
    emit({ type: "scrape:progress", data: organizeProgress });
    emit({
      type: "scrape:done",
      data: {
        total: organizeProgress.total,
        scraped: organizeProgress.scraped,
        success: organizeProgress.success,
        failed: organizeProgress.failed,
        skipped: organizeProgress.skipped,
        notFound: organizeProgress.notFound,
        canceled: true,
      },
    });

    return { ok: false, error: msg };
  }
}
