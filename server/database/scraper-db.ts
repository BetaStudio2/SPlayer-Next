import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { libraryLog } from "@main/utils/logger";
import { databaseDir } from "@main/utils/paths";

/**
 * 刮削器独立数据库 — scraper-state.db
 *
 * 与 library.db 分离，避免队列/Pending 状态与媒体库数据混写。
 * 仅包含 scrape_queue 表，用于 C++ 刮削器的任务分发与重试追踪。
 */

const scraperDbPath = path.join(databaseDir, "scraper-state.db");

let scraperDb: Database.Database | null = null;

export const getScraperDb = (): Database.Database => {
  if (!scraperDb) throw new Error("Scraper DB not initialized");
  return scraperDb;
};

export const isScraperDbOpen = (): boolean => scraperDb !== null;

export const initScraperDb = (): void => {
  fs.mkdirSync(databaseDir, { recursive: true });
  scraperDb = new Database(scraperDbPath);
  scraperDb.pragma("journal_mode = WAL");

  scraperDb.exec(`
    CREATE TABLE IF NOT EXISTS scrape_queue (
      track_id TEXT PRIMARY KEY,
      status TEXT NOT NULL DEFAULT 'pending',
      retries INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_scrape_queue_status ON scrape_queue(status);
  `);

  libraryLog.info(`刮削器数据库已初始化: ${scraperDbPath}`);
};

export const closeScraperDb = (): void => {
  if (scraperDb) {
    scraperDb.close();
    scraperDb = null;
    libraryLog.info("刮削器数据库已关闭");
  }
};
