import localforage from "localforage";
import type { Track, Artist } from "@shared/types/player";
import type { AlbumSummary, ArtistSummary, ScanProgress } from "@shared/types/library";
import type { Collection } from "@/types/collection";
import type { ArtistProfile, CoverItem } from "@/types/artist";
import { buildFolderTree, countFolders } from "@/utils/folderTree";
import { isElectron } from "@/utils/config";
import { wsManager } from "@/services/ws";
import { scraperApi, type ScrapeProgress } from "@/services/scraper";
import { toast } from "@/composables/useToast";
import i18n from "@/i18n";

const { t } = i18n.global;

const trackDb = localforage.createInstance({ name: "splayer", storeName: "library" });

/** 本地喜欢 id 在 trackDb 内的持久化 key */
const LIKED_IDS_KEY = "liked-ids";

export const useLibraryStore = defineStore("library", () => {
  /** 曲目列表 */
  const tracks = shallowRef<Track[]>([]);
  /** 扫描目录列表 */
  const scanDirs = ref<string[]>([]);
  /** 刮削目录列表 */
  const scrapeDirs = ref<string[]>([]);
  /** 刮削后是否自动整理到音乐库目录（默认开启，按歌手归类） */
  const organizeAfterScrape = ref(true);
  /** 整理目标目录 */
  const organizeTargetDir = ref("");
  /** 整理模板 */
  const organizePattern = ref("{artist}/{album}/{track}. {title}.{ext}");
  /** 是否跳过已刮削文件 */
  const skipScraped = ref(true);
  /** 是否使用 MusicBrainz 数据源 */
  const useMusicBrainz = ref(true);
  /** 是否使用 Deezer 数据源 */
  const useDeezer = ref(true);
  /** 是否使用 iTunes Search 数据源 */
  const useItunes = ref(true);
  /** 是否使用网易云数据源（中文音乐） */
  const useNetease = ref(true);
  /** 是否使用 QQ 音乐数据源（中文音乐） */
  const useQQMusic = ref(true);
  /** 是否使用酷狗数据源（中文音乐） */
  const useKugou = ref(true);
  /** 是否使用酷我数据源（中文音乐） */
  const useKuwo = ref(true);
  /** 是否使用咪咕数据源（中文音乐） */
  const useMigu = ref(true);
  /** 多源并发查询线程数 */
  const concurrentWorkers = ref(4);
  /** 是否正在扫描 */
  const scanning = ref(false);
  /** 扫描进度 */
  const scanProgress = ref<ScanProgress | null>(null);
  /** 是否正在刮削 */
  const scraping = ref(false);
  /** 刮削进度 */
  const scrapeProgress = ref<ScrapeProgress | null>(null);
  /** 是否已初始化 */
  const initialized = ref(false);
  /** 歌手头像缓存 */
  const artistAvatars = shallowRef<Record<string, string>>({});
  /** 本地红心 id */
  const likedOrderedIds = shallowRef<string[]>([]);
  /** 本地红心 id 集合 */
  const likedIdSet = shallowRef<Set<string>>(new Set());

  /** 持久化喜欢列表 */
  const persistLiked = (): void => {
    trackDb.setItem(LIKED_IDS_KEY, [...likedOrderedIds.value]).catch(() => {});
  };

  /** 是否已收藏 */
  const isLiked = (trackId: string): boolean => likedIdSet.value.has(trackId);

  /**
   * 切换收藏
   * @param trackId 歌曲 id
   */
  const toggleLike = (trackId: string): boolean => {
    if (!trackId) return false;
    const next = new Set(likedIdSet.value);
    if (next.has(trackId)) {
      next.delete(trackId);
      likedOrderedIds.value = likedOrderedIds.value.filter((id) => id !== trackId);
    } else {
      next.add(trackId);
      likedOrderedIds.value = [trackId, ...likedOrderedIds.value];
    }
    likedIdSet.value = next;
    persistLiked();
    return next.has(trackId);
  };

  /** 标准化歌手名 */
  const normalizeArtistName = (name: string): string => name.trim().toLowerCase();

  /**
   * 获取歌手头像
   * @param artistName 歌手名
   */
  const getArtistAvatar = (artistName: string): string | undefined => {
    const key = normalizeArtistName(artistName);
    if (!key) return;
    return artistAvatars.value[key];
  };

  /**
   * 设置歌手头像
   * @param artistName 歌手名
   * @param avatar 歌手头像
   */
  const setArtistAvatar = (artistName: string, avatar: string): void => {
    const key = normalizeArtistName(artistName);
    if (!key || !avatar) return;
    if (artistAvatars.value[key] === avatar) return;
    artistAvatars.value = { ...artistAvatars.value, [key]: avatar };
  };

  /** 批量预取头像 */
  const loadArtistAvatars = async (): Promise<void> => {
    const list = await getArtistList();
    const names = list
      .filter((item) => !artistAvatars.value[normalizeArtistName(item.name)])
      .map((item) => item.name);
    if (!names.length) return;
    const res = await window.api.library.prefetchArtistAvatars(names);
    if (!res.success || !res.data) return;
    const patch: Record<string, string> = {};
    for (const [key, avatar] of Object.entries(res.data)) {
      if (avatar) patch[key] = avatar;
    }
    if (Object.keys(patch).length > 0) {
      artistAvatars.value = { ...artistAvatars.value, ...patch };
    }
  };

  /** 将曲目写入 IndexedDB 缓存 */
  const cacheTracks = (items: Track[]): void => {
    trackDb.setItem("tracks", toRaw(items)).catch(() => {});
  };

  /** 加载曲目和目录列表 */
  const load = async (): Promise<void> => {
    // 先从 IndexedDB 读缓存，立即渲染
    const [cached, likedCached] = await Promise.all([
      trackDb.getItem<Track[]>("tracks").catch(() => null),
      trackDb.getItem<string[]>(LIKED_IDS_KEY).catch(() => null),
    ]);
    if (cached?.length) tracks.value = cached;
    if (Array.isArray(likedCached)) {
      likedOrderedIds.value = likedCached;
      likedIdSet.value = new Set(likedCached);
    }
    // 拿最新数据并回写缓存
    const [tracksRes, dirsRes] = await Promise.all([
      window.api.library.getTracks(),
      window.api.library.getScanDirs(),
    ]);
    if (tracksRes.success && tracksRes.data) {
      tracks.value = tracksRes.data;
      cacheTracks(tracksRes.data);
    }
    if (dirsRes.success && dirsRes.data) scanDirs.value = dirsRes.data;
    // Web 模式下加载刮削目录配置
    if (!isElectron) {
      try {
        const res = await fetch("/api/config/library.scrapeDirs");
        if (res.ok) {
          const dirs = await res.json();
          if (Array.isArray(dirs)) scrapeDirs.value = dirs;
        }
      } catch (err) {
        console.warn("[library] load scrapeDirs failed:", err);
      }
      // 加载整理相关配置
      try {
        const [
          organizeRes, targetRes, patternRes, skipRes,
          mbRes, dzRes, itRes,
          neRes, qqRes, kgRes, kwRes, mgRes, cwRes,
        ] = await Promise.all([
          fetch("/api/config/library.organizeAfterScrape"),
          fetch("/api/config/library.organizeTargetDir"),
          fetch("/api/config/library.organizePattern"),
          fetch("/api/config/library.skipScraped"),
          fetch("/api/config/library.useMusicBrainz"),
          fetch("/api/config/library.useDeezer"),
          fetch("/api/config/library.useItunes"),
          fetch("/api/config/library.useNetease"),
          fetch("/api/config/library.useQQMusic"),
          fetch("/api/config/library.useKugou"),
          fetch("/api/config/library.useKuwo"),
          fetch("/api/config/library.useMigu"),
          fetch("/api/config/library.concurrentWorkers"),
        ]);
        if (organizeRes.ok) organizeAfterScrape.value = (await organizeRes.json()) === true;
        if (targetRes.ok) {
          const t = await targetRes.json();
          if (typeof t === "string") organizeTargetDir.value = t;
        }
        if (patternRes.ok) {
          const p = await patternRes.json();
          if (typeof p === "string" && p) organizePattern.value = p;
        }
        if (skipRes.ok) skipScraped.value = (await skipRes.json()) === true;
        if (mbRes.ok) useMusicBrainz.value = (await mbRes.json()) !== false;
        if (dzRes.ok) useDeezer.value = (await dzRes.json()) !== false;
        if (itRes.ok) useItunes.value = (await itRes.json()) !== false;
        if (neRes.ok) useNetease.value = (await neRes.json()) !== false;
        if (qqRes.ok) useQQMusic.value = (await qqRes.json()) !== false;
        if (kgRes.ok) useKugou.value = (await kgRes.json()) !== false;
        if (kwRes.ok) useKuwo.value = (await kwRes.json()) !== false;
        if (mgRes.ok) useMigu.value = (await mgRes.json()) !== false;
        if (cwRes.ok) {
          const cw = await cwRes.json();
          if (typeof cw === "number" && cw > 0) concurrentWorkers.value = cw;
        }
      } catch (err) {
        console.warn("[library] load organize config failed:", err);
      }
    }
    initialized.value = true;
    // 预取歌手头像
    loadArtistAvatars();
  };

  /** 开始扫描 */
  const startScan = async (incremental = true): Promise<void> => {
    if (scanning.value) return;
    scanning.value = true;
    scanProgress.value = { phase: "scanning", total: 0, scanned: 0 };
    try {
      const res = await window.api.library.scan(incremental);
      if (!res.success) {
        scanning.value = false;
        scanProgress.value = null;
      }
    } catch {
      scanning.value = false;
      scanProgress.value = null;
    }
  };

  /** 取消扫描 */
  const cancelScan = async (): Promise<void> => {
    await window.api.library.cancelScan();
    scanning.value = false;
    scanProgress.value = null;
  };

  /** 添加扫描目录；Web 服务端模式可传 dir 直接指定路径 */
  const addScanDir = async (dir?: string): Promise<{ success: boolean; error?: string }> => {
    const res = await window.api.library.addScanDir(dir);
    if (res.success) {
      const newDir = res.data as string;
      const nested = scanDirs.value.some(
        (d) =>
          newDir.startsWith(d + "\\") ||
          newDir.startsWith(d + "/") ||
          d.startsWith(newDir + "\\") ||
          d.startsWith(newDir + "/"),
      );
      if (nested) {
        await window.api.library.removeScanDir(newDir);
        return { success: false, error: "nested" };
      }
      scanDirs.value = [...scanDirs.value, newDir];
    }
    return res;
  };

  /** 移除扫描目录 */
  const removeScanDir = async (dir: string): Promise<void> => {
    await window.api.library.removeScanDir(dir);
    scanDirs.value = scanDirs.value.filter((d) => d !== dir);
    // 移除目录取消正在进行的扫描
    if (scanning.value) {
      scanning.value = false;
      scanProgress.value = null;
    }
    const res = await window.api.library.getTracks();
    if (res.success && res.data) {
      tracks.value = res.data;
      cacheTracks(res.data);
      loadArtistAvatars();
    }
  };

  let unsubscribe: (() => void) | null = null;

  /** 监听扫描进度 */
  const subscribeScanProgress = (): void => {
    unsubscribe?.();
    unsubscribe = window.api.library.onScanProgress((data) => {
      scanProgress.value = data;
      if (data.phase === "done") {
        scanning.value = false;
        window.api.library.getTracks().then((res) => {
          if (res.success && res.data) {
            tracks.value = res.data;
            cacheTracks(res.data);
            loadArtistAvatars();
          }
        });
      } else if (data.phase === "error") {
        scanning.value = false;
      }
    });
  };

  const unsubscribeScanProgress = (): void => {
    unsubscribe?.();
    unsubscribe = null;
  };

  /** 开始刮削
   * @param mode 运行模式 once | daemon
   * @param dirs 刮削目录列表。为空时使用已配置的 scrapeDirs
   */
  const startScrape = async (mode: "once" | "daemon" = "once", dirs?: string[]): Promise<boolean> => {
    if (scraping.value) return false;
    const useDirs = dirs ?? scrapeDirs.value;
    if (useDirs.length === 0) {
      toast.warning(t("library.noScrapeDirHint", "请先添加刮削目录"));
      return false;
    }
    scraping.value = true;
    scrapeProgress.value = { scraping: true, total: 0, scraped: 0, canceled: false };
    try {
      const res = await scraperApi.start(mode, useDirs);
      if (!res.ok) {
        scraping.value = false;
        scrapeProgress.value = null;
        return false;
      }
      if (res.progress) {
        const current = scrapeProgress.value;
        const currentDone = !!current && !current.scraping && !current.organizing;
        // 空目录等“秒退”场景里，WS 终态可能先于 start 响应到达；避免旧快照把终态覆盖回运行中。
        if (currentDone) {
          return true;
        }
        // 只合并进度数据，不覆盖 scraping 状态 —— WS 是权威来源
        // HTTP 响应先于 C++ 退出返回时 scraping=true，如果之后 WS scrape:done 已设为 false，
        // 用 HTTP 值覆盖会导致前端卡在"刮削中"
        scrapeProgress.value = {
          ...current,
          ...res.progress,
          scraping: scraping.value, // 保留 WS 已更新的 scraping 状态
        };
        // 安全网：total=0 表示空目录/C++已秒退，WS 事件可能已丢失
        // 延迟拉取服务端实际状态，防止前端永久卡在"正在刮削"
        if (res.progress.total === 0) {
          setTimeout(async () => {
            if (!scraping.value) return; // 已被 WS 事件纠正，无需兜底
            try {
              const latest = await scraperApi.getProgress();
              if (!latest.scraping && !latest.organizing) {
                scrapeProgress.value = latest;
                scraping.value = false;
              }
            } catch {
              // 静默忽略，前端仍可通过取消按钮强制退出
            }
          }, 2000);
        }
      }
      return true;
    } catch (err) {
      console.error("[library] startScrape failed:", err);
      scraping.value = false;
      scrapeProgress.value = null;
      return false;
    }
  };

  /** 取消刮削 */
  const cancelScrape = async (): Promise<void> => {
    try {
      await scraperApi.cancel();
    } catch (err) {
      console.error("[library] cancelScrape failed:", err);
    } finally {
      // 无论服务端当前状态如何，用户取消后应立即退出刮削 UI
      // 这是最终的安全网：即使 WS 事件丢失，用户也能手动退出
      scraping.value = false;
      scrapeProgress.value = null;
    }
  };

  /**
   * 纯整理模式：只整理文件不刮削
   * 适用于已经刮削完成、标签信息完善的媒体文件，
   * 直接按模板从刮削目录移动到音乐库目录
   */
  const startOrganize = async (): Promise<boolean> => {
    if (scraping.value) {
      toast.warning(t("library.scrapeRunningHint", "刮削器正在运行"));
      return false;
    }
    const useDirs = scrapeDirs.value;
    if (useDirs.length === 0) {
      toast.warning(t("library.noScrapeDirHint", "请先添加刮削目录"));
      return false;
    }
    if (!organizeTargetDir.value) {
      toast.warning(
        t("library.organizeNoTargetHint", "请先设置整理目标目录"),
      );
      return false;
    }
    scraping.value = true;
    scrapeProgress.value = {
      scraping: false,
      total: 0,
      scraped: 0,
      canceled: false,
      organizing: true,
      organizeDone: 0,
      organizeTotal: 0,
    };
    try {
      const res = await scraperApi.organize(
        useDirs,
        organizeTargetDir.value,
        organizePattern.value,
      );
      if (!res.ok) {
        scraping.value = false;
        scrapeProgress.value = null;
        toast.error(res.error ?? t("library.organizeFailed", "整理失败"));
        return false;
      }
      toast.success(
        t("library.organizeDone", {
          moved: res.result?.moved ?? 0,
          skipped: res.result?.skipped ?? 0,
          failed: res.result?.failed ?? 0,
        }),
      );
      scraping.value = false;
      scrapeProgress.value = null;
      return true;
    } catch (err) {
      scraping.value = false;
      scrapeProgress.value = null;
      console.error("[library] organize failed:", err);
      return false;
    }
  };

  /** 添加刮削目录 */
  const addScrapeDir = async (dir: string): Promise<{ success: boolean; error?: string }> => {
    if (!dir) return { success: false, error: "empty dir" };
    // 检查是否嵌套
    const nested = scrapeDirs.value.some(
      (d) =>
        dir.startsWith(d + "/") ||
        dir.startsWith(d + "\\") ||
        d.startsWith(dir + "/") ||
        d.startsWith(dir + "\\"),
    );
    if (nested) {
      return { success: false, error: "nested" };
    }
    const newDirs = [...scrapeDirs.value, dir];
    scrapeDirs.value = newDirs;
    // 保存到配置
    try {
      await fetch("/api/config/library.scrapeDirs", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(newDirs),
      });
      return { success: true };
    } catch (err) {
      console.error("[library] addScrapeDir failed:", err);
      scrapeDirs.value = scrapeDirs.value.filter((d) => d !== dir);
      return { success: false, error: "save failed" };
    }
  };

  /** 移除刮削目录 */
  const removeScrapeDir = async (dir: string): Promise<void> => {
    const newDirs = scrapeDirs.value.filter((d) => d !== dir);
    scrapeDirs.value = newDirs;
    try {
      await fetch("/api/config/library.scrapeDirs", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(newDirs),
      });
    } catch (err) {
      console.error("[library] removeScrapeDir failed:", err);
    }
  };

  /** 设置刮削后自动整理 */
  const setOrganizeAfterScrape = async (enabled: boolean): Promise<void> => {
    organizeAfterScrape.value = enabled;
    try {
      await fetch("/api/config/library.organizeAfterScrape", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(enabled),
      });
    } catch (err) {
      console.error("[library] setOrganizeAfterScrape failed:", err);
    }
  };

  /** 设置整理目标目录 */
  const setOrganizeTargetDir = async (dir: string): Promise<void> => {
    organizeTargetDir.value = dir;
    try {
      await fetch("/api/config/library.organizeTargetDir", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(dir),
      });
    } catch (err) {
      console.error("[library] setOrganizeTargetDir failed:", err);
    }
  };

  /** 设置整理模板 */
  const setOrganizePattern = async (pattern: string): Promise<void> => {
    organizePattern.value = pattern;
    try {
      await fetch("/api/config/library.organizePattern", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(pattern),
      });
    } catch (err) {
      console.error("[library] setOrganizePattern failed:", err);
    }
  };

  /** 设置是否跳过已刮削文件 */
  const setSkipScraped = async (skip: boolean): Promise<void> => {
    skipScraped.value = skip;
    try {
      await fetch("/api/config/library.skipScraped", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(skip),
      });
    } catch (err) {
      console.error("[library] setSkipScraped failed:", err);
    }
  };

  /** 设置是否使用 MusicBrainz */
  const setUseMusicBrainz = async (enabled: boolean): Promise<void> => {
    useMusicBrainz.value = enabled;
    try {
      await fetch("/api/config/library.useMusicBrainz", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(enabled),
      });
    } catch (err) {
      console.error("[library] setUseMusicBrainz failed:", err);
    }
  };

  /** 设置是否使用 Deezer */
  const setUseDeezer = async (enabled: boolean): Promise<void> => {
    useDeezer.value = enabled;
    try {
      await fetch("/api/config/library.useDeezer", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(enabled),
      });
    } catch (err) {
      console.error("[library] setUseDeezer failed:", err);
    }
  };

  /** 设置是否使用 iTunes Search */
  const setUseItunes = async (enabled: boolean): Promise<void> => {
    useItunes.value = enabled;
    try {
      await fetch("/api/config/library.useItunes", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(enabled),
      });
    } catch (err) {
      console.error("[library] setUseItunes failed:", err);
    }
  };

  /** 设置是否使用网易云 */
  const setUseNetease = async (enabled: boolean): Promise<void> => {
    useNetease.value = enabled;
    try {
      await fetch("/api/config/library.useNetease", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(enabled),
      });
    } catch (err) {
      console.error("[library] setUseNetease failed:", err);
    }
  };

  /** 设置是否使用 QQ 音乐 */
  const setUseQQMusic = async (enabled: boolean): Promise<void> => {
    useQQMusic.value = enabled;
    try {
      await fetch("/api/config/library.useQQMusic", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(enabled),
      });
    } catch (err) {
      console.error("[library] setUseQQMusic failed:", err);
    }
  };

  /** 设置是否使用酷狗 */
  const setUseKugou = async (enabled: boolean): Promise<void> => {
    useKugou.value = enabled;
    try {
      await fetch("/api/config/library.useKugou", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(enabled),
      });
    } catch (err) {
      console.error("[library] setUseKugou failed:", err);
    }
  };

  /** 设置是否使用酷我 */
  const setUseKuwo = async (enabled: boolean): Promise<void> => {
    useKuwo.value = enabled;
    try {
      await fetch("/api/config/library.useKuwo", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(enabled),
      });
    } catch (err) {
      console.error("[library] setUseKuwo failed:", err);
    }
  };

  /** 设置是否使用咪咕 */
  const setUseMigu = async (enabled: boolean): Promise<void> => {
    useMigu.value = enabled;
    try {
      await fetch("/api/config/library.useMigu", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(enabled),
      });
    } catch (err) {
      console.error("[library] setUseMigu failed:", err);
    }
  };

  /** 设置并发线程数 */
  const setConcurrentWorkers = async (workers: number): Promise<void> => {
    concurrentWorkers.value = workers;
    try {
      await fetch("/api/config/library.concurrentWorkers", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(workers),
      });
    } catch (err) {
      console.error("[library] setConcurrentWorkers failed:", err);
    }
  };

  let scrapeUnsubscribe: (() => void) | null = null;

  /** 监听刮削进度（Web 模式通过 WebSocket） */
  const subscribeScrapeProgress = (): void => {
    scrapeUnsubscribe?.();
    const unsubProgress = wsManager.on("scrape:progress", (data) => {
      const progress = data as ScrapeProgress;
      scrapeProgress.value = progress;
      scraping.value = progress.scraping || !!progress.organizing;
      // 整理模式中 organizing=true 时保持 scraping 可见，不提前隐藏进度条
      if (!progress.scraping && !progress.organizing) {
        scraping.value = false;
        // 刮削完成后刷新曲目列表
        window.api.library.getTracks().then((res) => {
          if (res.success && res.data) {
            tracks.value = res.data;
            cacheTracks(res.data);
          }
        });
      }
    });
    const unsubDone = wsManager.on("scrape:done", (data) => {
      const done = data as { total: number; scraped: number; success: number; failed: number; skipped: number; notFound: number; canceled: boolean };
      scraping.value = false;
      scrapeProgress.value = {
        ...(scrapeProgress.value ?? { scraping: false, total: 0, scraped: 0, canceled: false }),
        scraping: false,
        total: done.total,
        scraped: done.scraped,
        success: done.success,
        failed: done.failed,
        skipped: done.skipped,
        notFound: done.notFound,
        canceled: done.canceled,
      };
      // 刮削完成后刷新曲目列表
      window.api.library.getTracks().then((res) => {
        if (res.success && res.data) {
          tracks.value = res.data;
          cacheTracks(res.data);
        }
      });
    });
    void scraperApi.getProgress().then((progress) => {
      const current = scrapeProgress.value;
      const currentDone = !!current && !current.scraping && !current.organizing;
      // 订阅建立后，HTTP 快照可能晚于 WS 终态到达；忽略过期的运行中快照。
      if (currentDone && (progress.scraping || progress.organizing)) {
        return;
      }
      scrapeProgress.value = progress;
      scraping.value = progress.scraping || !!progress.organizing;
    }).catch(() => {
      // WS 仍是主通道；这里仅作首次订阅兜底
    });
    scrapeUnsubscribe = () => {
      unsubProgress();
      unsubDone();
    };
  };

  const unsubscribeScrapeProgress = (): void => {
    scrapeUnsubscribe?.();
    scrapeUnsubscribe = null;
  };

  /** 删除曲目文件并刷新列表 */
  const deleteTracks = async (paths: string[]): Promise<{ deleted: number; failed: number }> => {
    const res = await window.api.library.deleteTracks(paths);
    if (res.success) {
      // 找出被删歌曲的 id，用于裁喜欢
      const pathSet = new Set(paths);
      const deletedIds = new Set(
        tracks.value.filter((t) => t.path && pathSet.has(t.path)).map((t) => t.id),
      );
      // 从本地列表中移除已删除的曲目
      const remaining = tracks.value.filter((t) => !t.path || !pathSet.has(t.path));
      tracks.value = remaining;
      cacheTracks(remaining);
      // 同步剪掉失效的喜欢 id
      if (deletedIds.size > 0 && likedOrderedIds.value.some((id) => deletedIds.has(id))) {
        const filtered = likedOrderedIds.value.filter((id) => !deletedIds.has(id));
        likedOrderedIds.value = filtered;
        likedIdSet.value = new Set(filtered);
        persistLiked();
      }
      return res.data ?? { deleted: 0, failed: paths.length };
    }
    return { deleted: 0, failed: paths.length };
  };

  /**
   * 按 id 替换曲目数据并回写缓存（标签编辑后调用）
   * @param updates 更新后的 Track 列表
   */
  const applyTrackUpdates = (updates: Track[]): void => {
    if (updates.length === 0) return;
    const byId = new Map(updates.map((item) => [item.id, item]));
    if (!tracks.value.some((item) => byId.has(item.id))) return;
    tracks.value = tracks.value.map((item) => byId.get(item.id) ?? item);
    cacheTracks(tracks.value);
  };

  /** 文件夹树：按磁盘路径聚合，详见 utils/folderTree */
  const folderTree = computed(() => buildFolderTree(tracks.value, scanDirs.value));

  /** 文件夹总数（递归） */
  const folderCount = computed(() => countFolders(folderTree.value));

  /** 专辑聚合列表 */
  const getAlbumList = async (): Promise<AlbumSummary[]> => {
    const res = await window.api.library.getAlbums();
    return res.success && res.data ? res.data : [];
  };

  /** 歌手聚合列表 */
  const getArtistList = async (): Promise<ArtistSummary[]> => {
    const res = await window.api.library.getArtists();
    return res.success && res.data ? res.data : [];
  };

  /** 专辑详情 */
  const getAlbumCollection = async (albumName: string): Promise<Collection | null> => {
    const res = await window.api.library.getAlbumTracks(albumName);
    if (!res.success || !res.data?.length) return null;
    const albumTracks = res.data;
    const artistMap = new Map<string, Artist>();
    for (const t of albumTracks) {
      for (const a of t.artists) {
        const key = a.name.toLowerCase();
        if (!artistMap.has(key)) artistMap.set(key, a);
      }
    }
    return {
      id: encodeURIComponent(albumName),
      type: "album",
      source: "local",
      title: albumName,
      cover: albumTracks.find((t) => t.cover)?.cover,
      artists: [...artistMap.values()],
      tracks: albumTracks,
      trackCount: albumTracks.length,
    };
  };

  /** 歌手详情 */
  const getArtistProfile = async (artistName: string): Promise<ArtistProfile | null> => {
    const name = artistName.trim();
    if (!name) return null;
    const res = await window.api.library.getArtistTracks(name);
    if (!res.success || !res.data?.length) return null;
    const artistTracks = res.data;
    const albumMap = new Map<string, { cover?: string; count: number }>();
    for (const t of artistTracks) {
      if (!t.album?.name) continue;
      const key = t.album.name;
      const existing = albumMap.get(key);
      if (existing) {
        existing.count++;
        if (!existing.cover && t.cover) existing.cover = t.cover;
      } else {
        albumMap.set(key, { cover: t.cover, count: 1 });
      }
    }
    const albums: CoverItem[] = [...albumMap.entries()].map(([albumName, info]) => ({
      id: encodeURIComponent(albumName),
      title: albumName,
      cover: info.cover,
      trackCount: info.count,
    }));
    return {
      id: encodeURIComponent(name),
      name,
      avatar: getArtistAvatar(name),
      source: "local",
      tracks: artistTracks,
      albums,
      trackCount: artistTracks.length,
      albumCount: albums.length,
    };
  };

  return {
    tracks,
    scanDirs,
    scrapeDirs,
    organizeAfterScrape,
    organizeTargetDir,
    organizePattern,
    skipScraped,
    useMusicBrainz,
    useDeezer,
    useItunes,
    useNetease,
    useQQMusic,
    useKugou,
    useKuwo,
    useMigu,
    concurrentWorkers,
    scanning,
    scanProgress,
    scraping,
    scrapeProgress,
    initialized,
    artistAvatars,
    likedOrderedIds,
    likedIdSet,
    isLiked,
    toggleLike,
    load,
    startScan,
    cancelScan,
    addScanDir,
    removeScanDir,
    subscribeScanProgress,
    unsubscribeScanProgress,
    startScrape,
    cancelScrape,
    startOrganize,
    addScrapeDir,
    removeScrapeDir,
    setOrganizeAfterScrape,
    setOrganizeTargetDir,
    setOrganizePattern,
    setSkipScraped,
    setUseMusicBrainz,
    setUseDeezer,
    setUseItunes,
    setUseNetease,
    setUseQQMusic,
    setUseKugou,
    setUseKuwo,
    setUseMigu,
    setConcurrentWorkers,
    subscribeScrapeProgress,
    unsubscribeScrapeProgress,
    deleteTracks,
    applyTrackUpdates,
    getArtistAvatar,
    setArtistAvatar,
    loadArtistAvatars,
    getArtistList,
    getAlbumList,
    getAlbumCollection,
    getArtistProfile,
    folderTree,
    folderCount,
  };
});
