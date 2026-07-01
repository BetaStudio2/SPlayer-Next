/**
 * 音乐文件整理器
 *
 * 刮削完成后，根据用户设定的模板将文件从刮削目录移动到音乐库目录，
 * 按歌手/专辑/风格等维度自动归类，避免打乱现有排序。
 *
 * 工作流程：
 *   1. 扫描刮削目录，读取每个文件的元数据
 *   2. 根据模板生成目标"目录"路径（如 {artist}/{album}）
 *   3. 自动创建目标文件夹（无文件夹自动添加）
 *   4. 保留原文件名移动文件；命名冲突时追加序号
 *   5. 返回移动结果（成功/失败/跳过）
 *
 * 重要约束：
 *   - 不修改文件名（始终保留原始 basename）
 *   - 不删除任何现有文件夹（包括整理后的空源目录）
 *
 * 模板变量（仅用于生成目录路径，不影响文件名）：
 *   {artist}      艺术家（优先 albumArtist，回退 artist，再回退 "Unknown Artist"）
 *   {albumArtist} 专辑艺术家
 *   {album}       专辑名（空则为 "Unknown Album"）
 *   {genre}       流派（空则为 "Unknown Genre"）
 *   {year}        年份
 *   {disc}        碟片编号（两位数，如 01）
 *   {track}       曲目编号（两位数，如 01）
 *   {title}       标题
 *   {ext}         扩展名（不含点）
 */
import fs from "node:fs/promises";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { parseFile } from "music-metadata";
import { libraryLog } from "@main/utils/logger";

/** 整理结果 */
export interface OrganizeResult {
  /** 总文件数 */
  total: number;
  /** 成功移动数 */
  moved: number;
  /** 跳过数（目标已存在或无需移动） */
  skipped: number;
  /** 失败数 */
  failed: number;
  /** 失败详情 */
  failures: Array<{ file: string; reason: string }>;
  /** 移动详情（旧路径 → 新路径） */
  moves: Array<{ from: string; to: string }>;
}

/** 文件元数据（用于生成目标路径） */
interface FileMeta {
  title: string;
  artist: string;
  albumArtist: string;
  album: string;
  genre: string;
  year: number;
  track: number;
  disc: number;
}

/** 默认整理模板 */
export const DEFAULT_PATTERN = "{artist}/{album}/{track}. {title}.{ext}";

/** Windows/Linux 文件名非法字符 */
const ILLEGAL_CHARS = /[/\\:*?"<>|]/g;
/** 文件名最大长度（含扩展名） */
const MAX_FILENAME_LENGTH = 200;

/**
 * 清理文件名/路径段中的非法字符
 * - 替换非法字符为下划线
 * - 去除控制字符
 * - 去除首尾空格和点（Windows 不允许首尾空格/点）
 * - 限制长度
 */
function sanitizeSegment(name: string): string {
  let s = Array.from(name)
    .filter((c) => c.charCodeAt(0) > 0x1f)
    .join("")
    .replace(ILLEGAL_CHARS, "_")
    .trim()
    .replace(/^\.+|\.+$/g, "")
    .replace(/\s+/g, " ");
  if (s.length > MAX_FILENAME_LENGTH) {
    s = s.substring(0, MAX_FILENAME_LENGTH).trim();
  }
  return s || "Unknown";
}

/**
 * 根据模板和元数据生成目标相对路径（用于目录结构）
 * @param pattern 整理模板
 * @param meta 文件元数据
 * @param ext 文件扩展名（不含点）
 */
export function buildRelativePath(pattern: string, meta: FileMeta, ext: string): string {
  // 优先使用 albumArtist，回退 artist
  const artist = sanitizeSegment(meta.albumArtist || meta.artist || "Unknown Artist");
  const albumArtist = sanitizeSegment(meta.albumArtist || meta.artist || "Unknown Artist");
  const album = sanitizeSegment(meta.album || "Unknown Album");
  const genre = sanitizeSegment(meta.genre || "Unknown Genre");
  const year = meta.year > 0 ? String(meta.year) : "";
  const disc = meta.disc > 0 ? String(meta.disc).padStart(2, "0") : "";
  const track = meta.track > 0 ? String(meta.track).padStart(2, "0") : "";
  const title = sanitizeSegment(meta.title || "Unknown Title");
  const extension = ext.toLowerCase();

  let result = pattern;
  result = result.replace(/\{artist\}/g, artist);
  result = result.replace(/\{albumArtist\}/g, albumArtist);
  result = result.replace(/\{album\}/g, album);
  result = result.replace(/\{genre\}/g, genre);
  result = result.replace(/\{year\}/g, year);
  result = result.replace(/\{disc\}/g, disc);
  result = result.replace(/\{track\}/g, track);
  result = result.replace(/\{title\}/g, title);
  result = result.replace(/\{ext\}/g, extension);

  // 清理路径中可能产生的多余分隔符和空段
  const segments = result.split(/[/\\]/).map((s) => s.trim()).filter((s) => s.length > 0);
  return segments.join(path.sep);
}

/**
 * 根据模板生成目标"目录"相对路径（剥离最后的文件名段）
 *
 * 模板可能形如 `{artist}/{album}/{track}. {title}.{ext}`，
 * 其中 `{title}` 和 `{ext}` 用于文件名生成。本函数返回仅目录部分
 * （含模板中的目录层级，但不含依赖 {title}/{ext} 的最终文件名段），
 * 实际文件名使用源文件的原始 basename，确保不修改文件名。
 *
 * 规则：
 *   - 若模板最后一段包含 {title} 或 {ext}，视其为文件名模板 → 丢弃，仅保留前面的目录段
 *   - 否则将整个模板作为目录路径
 */
export function buildRelativeDir(pattern: string, meta: FileMeta, ext: string): string {
  const fullPath = buildRelativePath(pattern, meta, ext);
  const segments = fullPath.split(/[/\\]/).map((s) => s.trim()).filter((s) => s.length > 0);
  if (segments.length === 0) return "";
  // 检查最后一段是否像文件名（含扩展点或由 {title}/{ext} 渲染而来）
  const last = segments[segments.length - 1];
  const lastLooksLikeFile = /\.[a-zA-Z0-9]+$/.test(last);
  if (lastLooksLikeFile) {
    segments.pop();
  }
  return segments.join(path.sep);
}

/**
 * 从文件路径读取元数据
 */
async function readFileMeta(filePath: string): Promise<FileMeta | null> {
  try {
    const meta = await parseFile(filePath, { duration: false });
    const c = meta.common;
    return {
      title: c.title ?? "",
      artist: c.artist ?? "",
      albumArtist: c.albumartist ?? "",
      album: c.album ?? "",
      genre: (c.genre?.[0] ?? "") as string,
      year: c.year ?? 0,
      track: c.track?.no ?? 0,
      disc: c.disk?.no ?? 0,
    };
  } catch (err) {
    libraryLog.warn(`[organizer] 读取元数据失败 ${filePath}:`, err);
    return null;
  }
}

/**
 * 处理文件名冲突：如果目标已存在，追加序号
 * @param targetPath 期望的目标路径
 * @returns 不冲突的目标路径
 */
async function resolveConflict(targetPath: string): Promise<string> {
  if (!existsSync(targetPath)) return targetPath;

  const dir = path.dirname(targetPath);
  const ext = path.extname(targetPath);
  const base = path.basename(targetPath, ext);

  for (let i = 2; i < 1000; i++) {
    const candidate = path.join(dir, `${base} (${i})${ext}`);
    if (!existsSync(candidate)) return candidate;
  }
  // 极端情况：附加时间戳
  return path.join(dir, `${base}_${Date.now()}${ext}`);
}

/**
 * 判断路径是否在目录下（防止路径穿越）
 */
function isPathInside(filePath: string, dir: string): boolean {
  const normalized = path.resolve(filePath);
  const normalizedDir = path.resolve(dir);
  return normalized.startsWith(normalizedDir + path.sep);
}

/**
 * 扫描目录中的音频文件
 */
async function scanAudioFiles(dir: string): Promise<string[]> {
  const audioExts = new Set([
    ".mp3", ".flac", ".ogg", ".oga", ".opus",
    ".m4a", ".aac", ".mp4", ".wav", ".ape",
    ".wv", ".dsf", ".dsd", ".dff", ".aiff", ".aif",
  ]);
  const results: string[] = [];

  async function walk(d: string): Promise<void> {
    let entries: string[];
    try {
      entries = await fs.readdir(d);
    } catch {
      return;
    }
    for (const entry of entries) {
      const fullPath = path.join(d, entry);
      let stat;
      try {
        stat = await fs.stat(fullPath);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        await walk(fullPath);
      } else if (stat.isFile()) {
        const ext = path.extname(entry).toLowerCase();
        if (audioExts.has(ext)) {
          results.push(fullPath);
        }
      }
    }
  }

  await walk(dir);
  return results;
}

/**
 * 整理单个文件：读取元数据，根据模板移动到目标目录
 *
 * 重要：始终保留源文件的原始 basename，不根据模板生成新文件名。
 * 模板仅用于生成目标目录结构（如 `{artist}/{album}`）。
 *
 * @param filePath 源文件路径
 * @param targetDir 目标根目录
 * @param pattern 整理模板（仅用于生成目录路径）
 * @returns 新路径（若已移动），或 null（跳过/失败）
 */
export async function organizeFile(
  filePath: string,
  targetDir: string,
  pattern: string,
): Promise<{ newPath: string | null; error?: string }> {
  // 方向守卫：仅从刮削目录向音乐库目录移动，
  // 源文件若已在音乐库目录内则一律跳过，绝不处理现有音乐库文件
  if (isPathInside(filePath, targetDir)) {
    return { newPath: null };
  }

  // 读取元数据：失败时原地保留（跳过），不计为失败，留待下次处理
  const meta = await readFileMeta(filePath);
  if (!meta) {
    return { newPath: null };
  }

  const ext = path.extname(filePath).slice(1);
  // 仅生成目录路径（保留原文件名）
  const relativeDir = buildRelativeDir(pattern, meta, ext);

  // 目标目录 = 根目录 + 模板生成的相对目录
  const targetSubDir = relativeDir ? path.join(targetDir, relativeDir) : targetDir;

  // 防止路径穿越
  if (!isPathInside(targetSubDir, targetDir) && targetSubDir !== targetDir) {
    return { newPath: null, error: "目标路径越界" };
  }

  // 保留原始文件名
  const originalBasename = path.basename(filePath);
  const newPath = path.join(targetSubDir, originalBasename);

  // 如果源和目标相同，跳过
  if (path.resolve(filePath) === path.resolve(newPath)) {
    return { newPath: null };
  }

  // 创建目标目录（不删除任何现有文件夹）
  if (!existsSync(targetSubDir)) {
    mkdirSync(targetSubDir, { recursive: true });
  }

  // 处理命名冲突（保留原文件名，仅追加序号）
  const finalPath = await resolveConflict(newPath);

  // 移动文件（跨设备时回退到复制+删除）
  try {
    await fs.rename(filePath, finalPath);
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "EXDEV") {
      // 跨设备：复制后删除。
      // 复制失败时清理目标残留，避免半成品文件；
      // 删除源文件失败时仅告警（目标已写成功），不阻断流程
      try {
        await fs.copyFile(filePath, finalPath);
      } catch (copyErr) {
        await fs.unlink(finalPath).catch(() => {});
        throw copyErr;
      }
      try {
        await fs.unlink(filePath);
      } catch (unlinkErr) {
        libraryLog.warn(
          `[organizer] 源文件删除失败（目标已写入）${filePath}:`,
          unlinkErr,
        );
      }
    } else {
      throw err;
    }
  }

  return { newPath: finalPath };
}

/**
 * 整理目录中的所有音频文件
 * @param sourceDirs 源目录列表（刮削目录）
 * @param targetDir 目标根目录（音乐库目录）
 * @param pattern 整理模板
 * @param onProgress 进度回调（可选）
 * @param excludePaths 排除的文件路径集合（仅整理非排除文件；用于跳过刮削失败/未找到匹配的 pending 文件）
 */
export async function organizeDir(
  sourceDirs: string[],
  targetDir: string,
  pattern: string = DEFAULT_PATTERN,
  onProgress?: (current: number, total: number, file: string) => void,
  excludePaths?: Set<string>,
): Promise<OrganizeResult> {
  const result: OrganizeResult = {
    total: 0,
    moved: 0,
    skipped: 0,
    failed: 0,
    failures: [],
    moves: [],
  };

  libraryLog.info(`[organizer] 开始整理目录: ${sourceDirs.join(", ")} -> ${targetDir}`);

  // 避免目标目录成为自身整理的数据源
  const targetDirAbsolute = path.resolve(targetDir);
  const actualSrcDirs = sourceDirs.filter(d => path.resolve(d) !== targetDirAbsolute);

  if (actualSrcDirs.length === 0) {
    libraryLog.info("[organizer] 没有需要整理的目录");
    return result;
  }

  // 收集所有音频文件
  const allFiles: string[] = [];
  for (const dir of actualSrcDirs) {
    if (!existsSync(dir)) {
      libraryLog.warn(`[organizer] 源目录不存在: ${dir}`);
      continue;
    }
    const files = await scanAudioFiles(dir);
    allFiles.push(...files);
  }

  result.total = allFiles.length;
  libraryLog.info(`[organizer] 开始整理 ${result.total} 个文件到 ${targetDir}`);

  for (let i = 0; i < allFiles.length; i++) {
    const filePath = allFiles[i];
    onProgress?.(i + 1, result.total, filePath);

    // 刮削 pending/失败的文件应留在源目录，不整理入库
    if (excludePaths?.has(filePath)) {
      result.skipped++;
      continue;
    }

    try {
      const { newPath, error } = await organizeFile(filePath, targetDir, pattern);
      if (error) {
        result.failed++;
        result.failures.push({ file: filePath, reason: error });
      } else if (newPath) {
        result.moved++;
        result.moves.push({ from: filePath, to: newPath });
      } else {
        result.skipped++;
      }
    } catch (err) {
      result.failed++;
      result.failures.push({
        file: filePath,
        reason: err instanceof Error ? err.message : String(err),
      });
      libraryLog.error(`[organizer] 整理失败 ${filePath}:`, err);
    }
  }

  libraryLog.info(
    `[organizer] 整理完成: 移动 ${result.moved}, 跳过 ${result.skipped}, 失败 ${result.failed}`,
  );

  return result;
}

/**
 * 清理空的源目录（整理后可选）
 * 只删除叶子级别的空目录，不删除根目录
 */
export async function cleanEmptyDirs(dirs: string[]): Promise<void> {
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    await cleanEmptyDirRecursive(dir, dir);
  }
}

async function cleanEmptyDirRecursive(dir: string, rootDir: string): Promise<void> {
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return;
  }

  for (const entry of entries) {
    const fullPath = path.join(dir, entry);
    let stat;
    try {
      stat = await fs.stat(fullPath);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      await cleanEmptyDirRecursive(fullPath, rootDir);
    }
  }

  // 重新检查是否为空
  if (path.resolve(dir) === path.resolve(rootDir)) return;
  try {
    const reEntries = await fs.readdir(dir);
    if (reEntries.length === 0) {
      await fs.rmdir(dir);
      libraryLog.info(`[organizer] 清理空目录: ${dir}`);
    }
  } catch {
    // 忽略
  }
}
