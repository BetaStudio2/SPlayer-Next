import path from "node:path";
import { readFileSync } from "node:fs";
import { store } from "@main/store";
import { defaultCacheDir, musicDir } from "./paths";

/**
 * 服务端运行时配置 shim（替换 electron @electron-toolkit/utils + app）
 */

/** 是否为开发环境 */
export const isDev = process.env.NODE_ENV !== "production";

/** 是否为 Windows 系统 */
export const isWin = process.platform === "win32";
/** 是否为 macOS 系统 */
export const isMac = process.platform === "darwin";
/** 是否为 Linux 系统 */
export const isLinux = process.platform === "linux";

/** 是否为便携版（服务端恒为 false） */
export const isPortable = false;

/** 软件版本 */
const __pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf-8"));
export const appVersion: string = __pkg.version || "1.0.0";

/** 应用名称 */
export const appName = "SPlayer-Next";

/** 当前生效的缓存根目录 */
export const getAppCacheDir = (): string => store.get("cache.dir") || defaultCacheDir;

/** 当前生效的封面缩略图目录 */
export const getCoverCacheDir = (): string => path.join(getAppCacheDir(), "covers");

/** 当前生效的歌手头像目录 */
export const getArtistCacheDir = (): string => path.join(getAppCacheDir(), "artists");

/** 当前生效的背景图目录 */
export const getBackgroundsDir = (): string => path.join(getAppCacheDir(), "backgrounds");

/** 当前生效的歌曲缓存目录 */
export const getSongCacheDir = (): string => path.join(getAppCacheDir(), "songs");

/** 当前生效的下载目录（服务端落到数据目录下，Web 端无本地下载） */
export const getDownloadDir = (): string => store.get("download.dir") || path.join(musicDir, "downloads");
