import type Database from "better-sqlite3";

/** 当前 schema 版本 */
const SCHEMA_VERSION = 7;

type TableInfoRow = { name: string };

/** 判断表是否存在指定列 */
const hasColumn = (d: Database.Database, table: string, column: string): boolean => {
  const rows = d.prepare(`PRAGMA table_info(${table})`).all() as TableInfoRow[];
  return rows.some((r) => r.name === column);
};

/** 执行数据库迁移 */
export const migrate = (d: Database.Database): void => {
  const version = d.pragma("user_version", { simple: true }) as number;
  let v = version;

  // v1 → v2: 添加 file_mtime / file_ctime 列
  if (v < 2) {
    if (!hasColumn(d, "tracks", "file_mtime")) {
      d.exec("ALTER TABLE tracks ADD COLUMN file_mtime INTEGER");
    }
    if (!hasColumn(d, "tracks", "file_ctime")) {
      d.exec("ALTER TABLE tracks ADD COLUMN file_ctime INTEGER");
    }
    v = 2;
  }

  // v2 → v3: 添加 track 列
  if (v < 3) {
    if (!hasColumn(d, "tracks", "track")) {
      d.exec("ALTER TABLE tracks ADD COLUMN track INTEGER");
    }
    v = 3;
  }

  // v3 → v4: Subsonic 服务端表（users / starred / playlists / shares）
  if (v < 4) {
    d.exec(`
      CREATE TABLE IF NOT EXISTS subsonic_users (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL UNIQUE,
        password_cipher TEXT NOT NULL,
        is_admin INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS subsonic_starred (
        user_id TEXT NOT NULL,
        target_id TEXT NOT NULL,
        target_type TEXT NOT NULL,
        starred_at INTEGER NOT NULL,
        PRIMARY KEY (user_id, target_id, target_type)
      );
      CREATE TABLE IF NOT EXISTS subsonic_playlists (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        name TEXT NOT NULL,
        comment TEXT,
        public INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS subsonic_playlist_entries (
        playlist_id TEXT NOT NULL,
        track_id TEXT NOT NULL,
        position INTEGER NOT NULL,
        PRIMARY KEY (playlist_id, position)
      );
      CREATE TABLE IF NOT EXISTS subsonic_shares (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        name TEXT NOT NULL,
        description TEXT,
        url TEXT NOT NULL,
        expires_at INTEGER,
        created_at INTEGER NOT NULL,
        visit_count INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS subsonic_share_entries (
        share_id TEXT NOT NULL,
        track_id TEXT NOT NULL,
        PRIMARY KEY (share_id, track_id)
      );
    `);
    v = 4;
  }

  // v4 → v5: tracks 增加 lyrics 列（保存文件内嵌歌词原文）
  if (v < 5) {
    if (!hasColumn(d, "tracks", "lyrics")) {
      d.exec("ALTER TABLE tracks ADD COLUMN lyrics TEXT");
    }
    v = 5;
  }

  // v5 → v6: 刮削器新增列 + 刮削队列表
  if (v < 6) {
    const scrapeCols = [
      ["mbid", "TEXT"],
      ["album_mbid", "TEXT"],
      ["artist_mbid", "TEXT"],
      ["genre", "TEXT"],
      ["isrc", "TEXT"],
      ["label", "TEXT"],
      ["scraped_at", "INTEGER"],
      ["scraped_sources", "TEXT"],
    ] as const;
    for (const [col, type] of scrapeCols) {
      if (!hasColumn(d, "tracks", col)) {
        d.exec(`ALTER TABLE tracks ADD COLUMN ${col} ${type}`);
      }
    }
    // 这些列升级到 v7 后以 ALTER TABLE 方式补上
    // scrape_queue 已迁移至独立的 scraper-state.db
    v = 6;
  }

  // v6 → v7: 刮削器增强 - 新增 composer, album_artist, disc_number, year, cover_data 字段
  if (v < 7) {
    const extraCols = [
      ["composer", "TEXT"],
      ["album_artist", "TEXT"],
      ["disc_number", "INTEGER"],
      ["year", "INTEGER"],
      ["cover_data", "BLOB"],
      ["cover_mime", "TEXT"],
    ] as const;
    for (const [col, type] of extraCols) {
      if (!hasColumn(d, "tracks", col)) {
        d.exec(`ALTER TABLE tracks ADD COLUMN ${col} ${type}`);
      }
    }
    v = 7;
  }

  // 版本无关部分
  // 补 lyric_match_cache.extra 列
  if (!hasColumn(d, "lyric_match_cache", "extra")) {
    d.exec("ALTER TABLE lyric_match_cache ADD COLUMN extra TEXT");
  }

  if (v < SCHEMA_VERSION) v = SCHEMA_VERSION;
  if (v !== version) {
    d.pragma(`user_version = ${v}`);
  }
};
