import { mkdirSync } from "node:fs";
import path from "node:path";

/**
 * 服务端固定路径常量（替换桌面端 app.getPath）
 *
 * 通过环境变量可在容器与本地开发之间切换数据落点：
 *  - SPLAYER_DATA_DIR  数据根（配置/数据库/缓存/日志/插件），默认 <cwd>/data
 *  - SPLAYER_MUSIC_DIR 曲库根，默认 <dataRoot>/music；容器内由 Docker 指向 /app/music
 */
const dataRoot = process.env.SPLAYER_DATA_DIR
  ? path.resolve(process.env.SPLAYER_DATA_DIR)
  : path.resolve(process.cwd(), "data");

// 根目录必须存在，子目录由各消费者自行创建
mkdirSync(dataRoot, { recursive: true });

export { dataRoot };

/** 配置目录：settings.json / streaming.json / lastfm.json */
export const configDir = path.join(dataRoot, "config");

/** 数据库目录：library.db */
export const databaseDir = path.join(dataRoot, "database");

/** 默认缓存根目录：covers / artists / backgrounds / songs */
export const defaultCacheDir = path.join(dataRoot, "cache");

/** 日志根目录：应用日志 */
export const logsDir = path.join(dataRoot, "logs");

/** 插件根目录 */
export const pluginsDir = path.join(dataRoot, "plugins");

/** 曲库根目录：本地音乐文件挂载点 */
export const musicDir = process.env.SPLAYER_MUSIC_DIR
  ? path.resolve(process.env.SPLAYER_MUSIC_DIR)
  : path.join(dataRoot, "music");
