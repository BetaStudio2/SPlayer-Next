import { Hono } from "hono";
import {
  getAllTracks,
  getTrackCount,
  searchTracks,
  getAlbumList,
  getArtistList,
  getAlbumTracks,
  getArtistTracks,
  getTracksByIds,
  getRandomTrack,
  getRandomTracks,
  deleteTracksByDir,
} from "@main/database";
import { store } from "@main/store";
import { musicDir } from "@main/utils/paths";
import { startScan, cancelScan, isScanning, getScanProgress } from "@main/music/scanner";
import { serveTrackStream, serveTrackCover } from "@main/music/serve";
import { fetchArtistAvatar, prefetchArtistAvatars } from "@main/apis/musicbrainz";
import { libraryLog } from "@main/utils/logger";

const app = new Hono();

const ok = <T>(data: T) => ({ success: true as const, data });
const fail = (error: string) => ({ success: false as const, error });

/** 取扫描目录（空则回退到 musicDir） */
const scanDirs = (): string[] => {
  const dirs = store.get("library.scanDirs") as string[];
  return dirs && dirs.length > 0 ? dirs : [musicDir];
};

/** POST /scan  body={incremental?:boolean} —— 后台触发扫描 */
app.post("/scan", async (c) => {
  try {
    const { incremental } = (await c.req.json().catch(() => ({}))) as { incremental?: boolean };
    void startScan(scanDirs(), incremental ?? true); // 后台执行，立即返回
    return c.json(ok({ started: true }));
  } catch (err) {
    libraryLog.error("[music] 启动扫描失败:", err);
    return c.json(fail("UNKNOWN"));
  }
});

/** POST /scan/cancel */
app.post("/scan/cancel", (c) => {
  cancelScan();
  return c.json(ok({ canceled: true }));
});

/** GET /scan/progress */
app.get("/scan/progress", (c) => c.json(ok({ ...getScanProgress(), scanning: isScanning() })));

/** GET /tracks */
app.get("/tracks", (c) => c.json(ok(getAllTracks())));

/** GET /tracks/count */
app.get("/tracks/count", (c) => c.json(ok(getTrackCount())));

/** GET /tracks/random */
app.get("/tracks/random", (c) => c.json(ok(getRandomTrack())));

/** GET /tracks/randoms?limit= */
app.get("/tracks/randoms", (c) => {
  const limit = parseInt(c.req.query("limit") ?? "1", 10);
  return c.json(ok(getRandomTracks(limit)));
});

/** GET /tracks/by-ids?ids=a,b,c */
app.get("/tracks/by-ids", (c) => {
  const ids = (c.req.query("ids") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return c.json(ok(getTracksByIds(ids)));
});

/** GET /tracks/search?q= */
app.get("/tracks/search", (c) => c.json(ok(searchTracks(c.req.query("q") ?? ""))));

/** GET /albums */
app.get("/albums", (c) => c.json(ok(getAlbumList())));

/** GET /albums/tracks?name= */
app.get("/albums/tracks", (c) => c.json(ok(getAlbumTracks(c.req.query("name") ?? ""))));

/** GET /artists */
app.get("/artists", (c) => c.json(ok(getArtistList())));

/** GET /artists/tracks?name= */
app.get("/artists/tracks", (c) => c.json(ok(getArtistTracks(c.req.query("name") ?? ""))));

/** GET /artists/avatar?name= —— 返回 cache URL 或 null */
app.get("/artists/avatar", async (c) => {
  const name = c.req.query("name") ?? "";
  try {
    return c.json(ok(await fetchArtistAvatar(name)));
  } catch (err) {
    libraryLog.error(`[music] 获取歌手头像失败 [${name}]:`, err);
    return c.json(fail("UNKNOWN"));
  }
});

/** POST /artists/avatars/prefetch  body=string[] */
app.post("/artists/avatars/prefetch", async (c) => {
  const names = (await c.req.json().catch(() => [])) as string[];
  if (!Array.isArray(names) || names.length === 0) return c.json(ok({}));
  try {
    return c.json(ok(await prefetchArtistAvatars(names)));
  } catch (err) {
    libraryLog.error("[music] 预取歌手头像失败:", err);
    return c.json(fail("UNKNOWN"));
  }
});

/** GET /cover/:id?size= */
app.get("/cover/:id", (c) => serveTrackCover(c, c.req.param("id")));

/** GET /stream/:id —— HTTP Range 音频流 */
app.get("/stream/:id", (c) => serveTrackStream(c, c.req.param("id")));

/** GET /scan-dirs */
app.get("/scan-dirs", (c) => c.json(ok(store.get("library.scanDirs"))));

/** POST /scan-dirs  body={dir} */
app.post("/scan-dirs", async (c) => {
  const { dir } = (await c.req.json().catch(() => ({}))) as { dir?: string };
  if (!dir) return c.json(fail("missing dir"));
  const dirs = (store.get("library.scanDirs") as string[]) ?? [];
  if (dirs.includes(dir)) return c.json(fail("dir exists"));
  dirs.push(dir);
  store.set("library.scanDirs", dirs);
  return c.json(ok(dir));
});

/** POST /scan-dirs/remove  body={dir} */
app.post("/scan-dirs/remove", async (c) => {
  const { dir } = (await c.req.json().catch(() => ({}))) as { dir?: string };
  if (!dir) return c.json(fail("missing dir"));
  const dirs = (store.get("library.scanDirs") as string[]) ?? [];
  const idx = dirs.indexOf(dir);
  if (idx === -1) return c.json(fail("dir not found"));
  dirs.splice(idx, 1);
  store.set("library.scanDirs", dirs);
  if (isScanning()) cancelScan();
  deleteTracksByDir(dir);
  return c.json(ok({ removed: true }));
});

export default app;
