/**
 * Subsonic API 服务端实现
 *
 * SPlayer 作为流媒体服务器对外提供 Subsonic 协议，让任何 Subsonic 客户端
 * （Ultrasonic / playSub / substreamer / DSub 等）能连接浏览与播放。
 *
 * 路由挂载于 /rest/*，端点形如 /rest/ping.view?u=...&p=...&v=...&c=...&f=json
 *
 * 数据映射（SPlayer 扁平 tracks 表 → Subsonic 层级）：
 *   track id   = tracks.id
 *   album id   = md5(album.name) hex
 *   artist id  = md5(artist.name) hex
 *
 * 响应格式：默认 JSON（f=json），同时支持 XML（f=xml 或缺省）以兼容老客户端。
 */
import { Hono, type Context } from "hono";
import { createHash } from "node:crypto";
import path from "node:path";
import { existsSync, statSync, createReadStream } from "node:fs";
import { Readable } from "node:stream";
import sharp from "sharp";
import {
  getUserByUsername,
  listUsers,
  createUser,
  updateUser,
  deleteUser,
  type SubsonicUser,
  star,
  unstar,
  isStarred,
  getStarredIds,
  listPlaylists,
  getPlaylist,
  createPlaylist,
  updatePlaylist,
  deletePlaylist,
  listShares,
  createShare,
  updateShare,
  deleteShare,
  albumIdOf,
  artistIdOf,
  findAlbumNameById,
  findArtistNameById,
} from "@main/database/subsonic";
import {
  getAllTracks,
  getAlbumList,
  getArtistList,
  getAlbumTracks,
  getArtistTracks,
  searchTracks,
  getTracksByIds,
  getTrackLyrics,
  getRandomTracks,
} from "@main/database";
import { getCoverCacheDir } from "@main/utils/config";
import { serverLog } from "@main/utils/logger";
import * as neteaseLyric from "@main/apis/common/lyric/netease";
import type { Track, Artist, Album } from "@shared/types/player";
import type { AlbumSummary, ArtistSummary } from "@shared/types/library";

const app = new Hono();

const SUBSONIC_VERSION = "1.16.1";
const SERVER_NAME = "splayer";
const SERVER_VERSION = "1.0.0";

/* ------------------------------------------------------------------ */
/* 响应封装                                                            */
/* ------------------------------------------------------------------ */

interface SubError {
  code: number;
  message: string;
}

/** 构造 subsonic-response 主体 */
const buildBody = (status: "ok" | "failed", payload: Record<string, unknown> = {}, error?: SubError) => {
  const body: Record<string, unknown> = {
    status,
    version: SUBSONIC_VERSION,
    type: SERVER_NAME,
    serverVersion: SERVER_VERSION,
    ...payload,
  };
  if (error) body.error = error;
  return { "subsonic-response": body };
};

/* ------------------------------------------------------------------ */
/* 简易 XML 序列化（兼容老客户端）                                       */
/* ------------------------------------------------------------------ */

const singularMap: Record<string, string> = {
  artists: "artist",
  albums: "album",
  songs: "song",
  entries: "entry",
  playlists: "playlist",
  shares: "share",
  genres: "genre",
  indexes: "index",
  children: "child",
  musicFolders: "musicFolder",
  similarSongs: "similarSong",
  similarSongs2: "similarSong",
  searchResult2: "searchResult2",
  searchResult3: "searchResult3",
  artistsRoot: "artists",
};

const singularOf = (key: string): string => singularMap[key] ?? key.replace(/s$/, "");

const escapeXml = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const isPrimitive = (v: unknown): v is string | number | boolean =>
  typeof v === "string" || typeof v === "number" || typeof v === "boolean";

/** 对象 → XML 元素 */
const objToXml = (name: string, obj: unknown, indent = ""): string => {
  if (obj == null) return "";
  if (isPrimitive(obj)) return `${indent}<${name}>${escapeXml(String(obj))}</${name}>\n`;
  if (Array.isArray(obj)) {
    const child = singularOf(name);
    return obj.map((item) => objToXml(child, item, indent)).join("");
  }
  if (typeof obj === "object") {
    const o = obj as Record<string, unknown>;
    const attrs: string[] = [];
    const children: string[] = [];
    for (const [k, v] of Object.entries(o)) {
      if (v == null) continue;
      if (isPrimitive(v)) attrs.push(`${k}="${escapeXml(String(v))}"`);
      else children.push(objToXml(k, v, indent + "  "));
    }
    const attrStr = attrs.length ? " " + attrs.join(" ") : "";
    if (children.length === 0) return `${indent}<${name}${attrStr}/>\n`;
    return `${indent}<${name}${attrStr}>\n${children.join("")}${indent}</${name}>\n`;
  }
  return "";
};

/** 把 subsonic-response 主体序列化为 XML */
const toXml = (body: Record<string, unknown>): string => {
  const root = body["subsonic-response"] as Record<string, unknown>;
  return `<?xml version="1.0" encoding="UTF-8"?>\n${objToXml("subsonic-response", root)}`;
};

/* ------------------------------------------------------------------ */
/* 鉴权                                                                */
/* ------------------------------------------------------------------ */

declare module "hono" {
  interface ContextVariableMap {
    subsonicUser: SubsonicUser;
  }
}

const md5 = (s: string): string => createHash("md5").update(s).digest("hex");

/** 验证 Subsonic 鉴权参数 */
const authenticate = (u?: string, p?: string, t?: string, s?: string): SubsonicUser => {
  if (!u) throw { code: 10, message: "Missing required parameter u" } as SubError;
  const user = getUserByUsername(u);
  if (!user) throw { code: 40, message: "Wrong username or password" } as SubError;

  // token + salt 模式
  if (t && s) {
    const expected = md5(user.password + s);
    if (expected !== t) throw { code: 40, message: "Wrong username or password" } as SubError;
    return user;
  }
  // 明文密码模式（可能带 enc:hex: 前缀）
  if (p) {
    let plain = p;
    if (plain.startsWith("enc:hex:")) {
      plain = Buffer.from(plain.slice(8), "hex").toString("utf-8");
    }
    if (plain !== user.password) throw { code: 40, message: "Wrong username or password" } as SubError;
    return user;
  }
  throw { code: 10, message: "Missing authentication" } as SubError;
};

/** 鉴权中间件：解析 u/p/t/s，挂到 c.var.subsonicUser */
app.all("/*", async (c, next) => {
  try {
    const q = c.req.query();
    let u = q.u, p = q.p, t = q.t, s = q.s;
    // POST 表单支持
    if (!u && c.req.method === "POST") {
      const form = await c.req.formData().catch(() => null);
      if (form) {
        u = form.get("u") as string | undefined ?? u;
        p = form.get("p") as string | undefined ?? p;
        t = form.get("t") as string | undefined ?? t;
        s = form.get("s") as string | undefined ?? s;
      }
    }
    const user = authenticate(u, p, t, s);
    c.set("subsonicUser", user);
    await next();
  } catch (err) {
    const e = err as SubError;
    return send(c, {}, e);
  }
});

/* ------------------------------------------------------------------ */
/* 发送响应（按 f 参数选 JSON/XML）                                     */
/* ------------------------------------------------------------------ */

const send = (c: Context, payload: Record<string, unknown>, error?: SubError) => {
  const format = c.req.query("f") ?? "xml";
  const body = buildBody(error ? "failed" : "ok", payload, error);
  if (format === "json") return c.json(body);
  return c.body(toXml(body), 200, { "Content-Type": "text/xml; charset=utf-8" });
};

/* ------------------------------------------------------------------ */
/* Track → Subsonic Child 映射                                         */
/* ------------------------------------------------------------------ */

const firstArtist = (artists: Artist[]): string => artists.map((a) => a.name).join(" / ");
const firstArtistId = (artists: Artist[]): string | undefined =>
  artists[0] ? artistIdOf(artists[0].name) : undefined;

const audioMime: Record<string, string> = {
  mp3: "audio/mpeg", flac: "audio/flac", ogg: "audio/ogg", opus: "audio/ogg",
  oga: "audio/ogg", m4a: "audio/mp4", aac: "audio/aac", wav: "audio/wav",
  ape: "audio/x-ape", wv: "audio/x-wavpack", dsf: "audio/x-dsf", mp4: "audio/mp4",
  aiff: "audio/aiff", aif: "audio/aiff",
};

const suffixOf = (filePath: string): string => path.extname(filePath).slice(1).toLowerCase();
const mimeOf = (filePath: string): string => audioMime[suffixOf(filePath)] ?? "application/octet-stream";
const parseIntOr = (value: string | undefined, fallback: number): number => {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const trackToChild = (t: Track, userId: string, includeStarred = true) => {
  const albumName = t.album?.name ?? "";
  const filePath = t.path ?? "";
  const child: Record<string, unknown> = {
    id: t.id,
    parent: albumName ? albumIdOf(albumName) : undefined,
    isDir: false,
    title: t.title,
    album: albumName || undefined,
    artist: firstArtist(t.artists),
    track: t.track ?? undefined,
    coverArt: t.id,
    size: t.fileSize ?? 0,
    contentType: mimeOf(filePath),
    suffix: suffixOf(filePath),
    duration: Math.round(t.duration),
    bitRate: t.quality?.bitRate ?? 0,
    path: filePath ? path.basename(filePath) : t.id,
    discNumber: 1,
    type: "music",
    created: new Date(t.ctime ?? t.mtime ?? Date.now()).toISOString(),
    artistId: firstArtistId(t.artists),
    albumId: albumName ? albumIdOf(albumName) : undefined,
  };
  if (includeStarred && isStarred(userId, t.id, "track")) {
    child.starred = new Date().toISOString();
  }
  return child;
};

const trackToSong = (t: Track, userId: string) => trackToChild(t, userId);

/** album summary → subsonic album（带 songCount/duration） */
const albumListRowToAlbum = (row: AlbumSummary) => {
  const tracks = getAlbumTracks(row.name);
  const duration = tracks.reduce((sum, t) => sum + Math.round(t.duration), 0);
  return {
    id: albumIdOf(row.name),
    name: row.name,
    artist: row.artist,
    artistId: row.artist ? artistIdOf(row.artist) : undefined,
    coverArt: tracks.find((t) => t.cover)?.id ?? albumIdOf(row.name),
    songCount: row.trackCount,
    duration,
    created: new Date(tracks[0]?.ctime ?? Date.now()).toISOString(),
  };
};

const artistListRowToArtist = (row: ArtistSummary) => {
  const albums = new Set(
    getArtistTracks(row.name)
      .map((t) => t.album?.name)
      .filter(Boolean) as string[],
  );
  return {
    id: artistIdOf(row.name),
    name: row.name,
    coverArt: row.cover ? artistIdOf(row.name) : undefined,
    albumCount: albums.size,
  };
};

/* ------------------------------------------------------------------ */
/* 歌词（LRC）                                                         */
/* ------------------------------------------------------------------ */

/** LRC 时间标签 → 毫秒，如 [01:23.45] → 83450，[00:01:23.45] → 83450 */
const lrcTimeToMs = (hh: string | undefined, mm: string, ss: string, xx: string): number => {
  const hours = hh ? parseInt(hh, 10) || 0 : 0;
  const minutes = parseInt(mm, 10) || 0;
  const seconds = parseInt(ss, 10) || 0;
  const frac = xx ? parseFloat(`0.${xx}`) * 1000 : 0;
  return hours * 3_600_000 + minutes * 60_000 + seconds * 1000 + Math.round(frac);
};

interface LrcLine {
  start: number;
  value: string;
}

/** 解析 LRC 文本为带时间戳的行（过滤元数据标签） */
const parseLrc = (text: string): LrcLine[] => {
  const lines: LrcLine[] = [];
  // 支持 [mm:ss.xx] / [mm:ss.xx] / [hh:mm:ss.xx] / [hh:mm:ss:xx]
  const re = /\[(?:(\d{1,2}):)?(\d{1,2}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;
  for (const raw of text.split(/\r?\n/)) {
    re.lastIndex = 0;
    const stamps: number[] = [];
    let m: RegExpExecArray | null;
    while ((m = re.exec(raw)) !== null) stamps.push(lrcTimeToMs(m[1], m[2], m[3], m[4] ?? ""));
    if (stamps.length === 0) continue;
    const value = raw.replace(re, "").trim();
    for (const start of stamps) lines.push({ start, value });
  }
  return lines.sort((a, b) => a.start - b.start);
};

/**
 * 为指定 Track 拉取歌词：
 * 1) 优先读音乐文件内嵌歌词元数据（USLT/SYLT/LYRICS）
 * 2) 回退到 netease 在线匹配，取标准 LRC 文本
 * 返回 { main, translation } 原始歌词文本，未命中返回 null。
 */
const fetchLyricForTrack = async (
  track: Track,
): Promise<{ main: string; translation?: string } | null> => {
  // 1) 内嵌歌词
  if (track.id) {
    const embedded = getTrackLyrics(track.id);
    if (embedded && embedded.trim()) {
      return { main: embedded };
    }
  }
  // 2) 在线匹配
  try {
    const main = await neteaseLyric.getLrcByQuery(track);
    if (main) return { main };
  } catch (err) {
    serverLog.warn(`[subsonic] fetchLyricForTrack(${track.title}) netease failed:`, err);
  }
  return null;
};

/* ------------------------------------------------------------------ */
/* 端点分发                                                            */
/* ------------------------------------------------------------------ */

app.all("/*", async (c) => {
  // 解析端点名：取路径最后一段（去掉 .view 后缀）
  // 兼容客户端把 /rest 也填入"服务器地址"导致的 /rest/rest/<endpoint> 双重前缀
  // 例如 /rest/ping.view / /rest/rest/getCoverArt / /rest/getCoverArt → ping / getCoverArt
  const full = c.req.path;
  const m = /\/([^/]+?)(?:\.view)?$/i.exec(full);
  const endpoint = (m?.[1] ?? "").toLowerCase();
  const user = c.get("subsonicUser");
  const q = c.req.query();

  try {
    switch (endpoint) {
      /* ---- 基础 ---- */
      case "ping":
        return send(c, {});

      case "getlicense":
        return send(c, { license: { valid: true, email: "splayer@local", licenseExpires: "2099-01-01" } });

      case "getmusicfolders":
        return send(c, { musicFolders: { musicFolder: [{ id: 0, name: "Music" }] } });

      case "getindexes": {
        // 简化：返回所有歌手按首字母分组
        const artists = getArtistList();
        const groups: Record<string, typeof artists> = {};
        for (const a of artists) {
          const idx = /^[a-z]/i.test(a.name) ? a.name[0].toUpperCase() : "#";
          (groups[idx] ??= []).push(a);
        }
        const index = Object.entries(groups).map(([name, list]) => ({
          name,
          artist: list.map((a) => artistListRowToArtist(a)),
        }));
        // Subsonic 协议要求 ignoredArticles 字段
        return send(c, { indexes: { ignoredArticles: "The El", index } });
      }

      case "getartists": {
        const artists = getArtistList();
        const groups: Record<string, typeof artists> = {};
        for (const a of artists) {
          const idx = /^[a-z]/i.test(a.name) ? a.name[0].toUpperCase() : "#";
          (groups[idx] ??= []).push(a);
        }
        const index = Object.entries(groups).map(([name, list]) => ({
          name,
          artist: list.map((a) => artistListRowToArtist(a)),
        }));
        // Subsonic 协议要求 ignoredArticles 字段
        return send(c, { artists: { ignoredArticles: "The El", index } });
      }

      case "getartist": {
        const name = findArtistNameById(q.id ?? "");
        if (!name) return send(c, {}, { code: 70, message: "Artist not found" });
        const tracks = getArtistTracks(name);
        const albumNames = [...new Set(tracks.map((t) => t.album?.name).filter(Boolean))] as string[];
        const albums = albumNames.map((an) => {
          const at = getAlbumTracks(an);
          return {
            id: albumIdOf(an),
            name: an,
            artist: name,
            artistId: artistIdOf(name),
            coverArt: at.find((t) => t.cover)?.id ?? albumIdOf(an),
            songCount: at.length,
            duration: at.reduce((s, t) => s + Math.round(t.duration), 0),
            created: new Date(at[0]?.ctime ?? Date.now()).toISOString(),
          };
        });
        return send(c, {
          artist: {
            id: artistIdOf(name),
            name,
            coverArt: tracks.some((track) => track.cover) ? artistIdOf(name) : undefined,
            albumCount: albums.length,
            album: albums,
          },
        });
      }

      case "getalbum": {
        const name = findAlbumNameById(q.id ?? "");
        if (!name) return send(c, {}, { code: 70, message: "Album not found" });
        const tracks = getAlbumTracks(name);
        return send(c, {
          album: {
            id: albumIdOf(name),
            name,
            artist: tracks[0] ? firstArtist(tracks[0].artists) : "",
            artistId: tracks[0] ? firstArtistId(tracks[0].artists) : undefined,
            coverArt: tracks.find((t) => t.cover)?.id ?? albumIdOf(name),
            songCount: tracks.length,
            duration: tracks.reduce((s, t) => s + Math.round(t.duration), 0),
            created: new Date(tracks[0]?.ctime ?? Date.now()).toISOString(),
            song: tracks.map((t) => trackToChild(t, user.id)),
          },
        });
      }

      case "getalbumlist":
      case "getalbumlist2": {
        const type = q.type ?? "newest";
        const size = Math.min(parseIntOr(q.size, 10), 500);
        const offset = Math.max(0, parseIntOr(q.offset, 0));
        const all = getAlbumList();
        let list = all;
        // 按 Subsonic 协议规范排序
        if (type === "newest") {
          // 按创建时间降序（使用第一首歌的 ctime）
          list = [...all].sort((a, b) => {
            const aTracks = getAlbumTracks(a.name);
            const bTracks = getAlbumTracks(b.name);
            const aTime = aTracks[0]?.ctime ?? 0;
            const bTime = bTracks[0]?.ctime ?? 0;
            return bTime - aTime;
          });
        } else if (type === "frequent") {
          // 简化：按歌曲数量降序（无播放统计）
          list = [...all].sort((a, b) => b.trackCount - a.trackCount);
        } else if (type === "recent") {
          // 简化：同 newest（无播放历史）
          list = [...all].sort((a, b) => {
            const aTracks = getAlbumTracks(a.name);
            const bTracks = getAlbumTracks(b.name);
            const aTime = aTracks[0]?.ctime ?? 0;
            const bTime = bTracks[0]?.ctime ?? 0;
            return bTime - aTime;
          });
        } else if (type === "random") {
          list = [...all].sort(() => Math.random() - 0.5);
        } else if (type === "alphabeticalByName") {
          list = [...all].sort((a, b) => a.name.localeCompare(b.name));
        } else if (type === "alphabeticalByArtist") {
          list = [...all].sort((a, b) => a.artist.localeCompare(b.artist));
        } else if (type === "byYear") {
          // 按年份排序（需要解析专辑名或元数据，简化实现）
          list = [...all].sort((a, b) => a.name.localeCompare(b.name));
        } else if (type === "byGenre") {
          // 按流派排序（SPlayer 未持久化 genre，简化实现）
          list = [...all].sort((a, b) => a.name.localeCompare(b.name));
        }
        list = list.slice(offset, offset + size);
        const albums = list.map((r) => albumListRowToAlbum(r));
        const key = endpoint === "getalbumlist2" ? "albumList2" : "albumList";
        return send(c, { [key]: { album: albums } });
      }

      case "getsong": {
        const track = getTracksByIds([q.id ?? ""])[0];
        if (!track) return send(c, {}, { code: 70, message: "Song not found" });
        return send(c, { song: trackToSong(track, user.id) });
      }

      case "getrandomsongs": {
        const size = Math.min(parseInt(q.size ?? "10", 10) || 10, 500);
        const tracks = getRandomTracks(size);
        return send(c, { randomSongs: { song: tracks.map((t) => trackToSong(t, user.id)) } });
      }

      case "getcoverart": {
        const id = q.id ?? "";
        const size = q.size ? parseInt(q.size, 10) : 0;
        return serveCover(c, id, size);
      }

      case "stream":
      case "download": {
        const id = q.id ?? "";
        const track = getTracksByIds([id])[0];
        if (!track?.path || !existsSync(track.path)) {
          return send(c, {}, { code: 70, message: "Song not found" });
        }
        return serveStream(c, track.path, endpoint === "download");
      }

      case "search2":
      case "search3": {
        const query = q.query ?? "";
        const artistCount = Math.min(Math.max(0, parseIntOr(q.artistCount, 10)), 500);
        const albumCount = Math.min(Math.max(0, parseIntOr(q.albumCount, 10)), 500);
        const songCount = Math.min(Math.max(0, parseIntOr(q.songCount, 10)), 500);
        const artistOffset = Math.max(0, parseIntOr(q.artistOffset, 0));
        const albumOffset = Math.max(0, parseIntOr(q.albumOffset, 0));
        const songOffset = Math.max(0, parseIntOr(q.songOffset, 0));
        const tracks = query ? searchTracks(query) : getAllTracks();
        const matchedArtists = new Map<string, ArtistSummary>();
        const matchedAlbums = new Map<string, AlbumSummary>();
        for (const t of tracks) {
          for (const a of t.artists) {
            if (!matchedArtists.has(a.name)) {
              const at = getArtistTracks(a.name);
              matchedArtists.set(a.name, { name: a.name, trackCount: at.length, cover: at.find((x) => x.cover)?.cover });
            }
          }
          if (t.album?.name && !matchedAlbums.has(t.album.name)) {
            const at = getAlbumTracks(t.album.name);
            matchedAlbums.set(t.album.name, {
              name: t.album.name,
              cover: at.find((x) => x.cover)?.cover,
              artist: at[0] ? firstArtist(at[0].artists) : "",
              trackCount: at.length,
            });
          }
        }
        const result = {
          artist: [...matchedArtists.values()]
            .slice(artistOffset, artistOffset + artistCount)
            .map((a) => artistListRowToArtist(a)),
          album: [...matchedAlbums.values()]
            .slice(albumOffset, albumOffset + albumCount)
            .map((a) => albumListRowToAlbum(a)),
          song: tracks.slice(songOffset, songOffset + songCount).map((t) => trackToSong(t, user.id)),
        };
        const key = endpoint === "search3" ? "searchResult3" : "searchResult2";
        return send(c, { [key]: result });
      }

      case "getstarred":
      case "getstarred2": {
        const starred = getStarredIds(user.id);
        const songs = getTracksByIds(starred.tracks).map((t) => trackToSong(t, user.id));
        const albums = starred.albums
          .map((id) => findAlbumNameById(id))
          .filter((n): n is string => !!n)
          .map((name) => {
            const row = getAlbumList().find((a) => a.name === name)!;
            return albumListRowToAlbum(row);
          });
        const artists = starred.artists
          .map((id) => findArtistNameById(id))
          .filter((n): n is string => !!n)
          .map((name) => {
            const row = getArtistList().find((a) => a.name === name)!;
            return artistListRowToArtist(row);
          });
        const key = endpoint === "getstarred2" ? "starred2" : "starred";
        return send(c, { [key]: { song: songs, album: albums, artist: artists } });
      }

      case "star": {
        const ids = collectIds(q, "id");
        const albumIds = collectIds(q, "albumId");
        const artistIds = collectIds(q, "artistId");
        for (const id of ids) star(user.id, id, "track");
        for (const id of albumIds) star(user.id, id, "album");
        for (const id of artistIds) star(user.id, id, "artist");
        return send(c, {});
      }

      case "unstar": {
        const ids = collectIds(q, "id");
        const albumIds = collectIds(q, "albumId");
        const artistIds = collectIds(q, "artistId");
        for (const id of ids) unstar(user.id, id, "track");
        for (const id of albumIds) unstar(user.id, id, "album");
        for (const id of artistIds) unstar(user.id, id, "artist");
        return send(c, {});
      }

      case "scrobble": {
        // 简单记录到 server 日志（可后续接入 play_history）
        const id = q.id ?? "";
        serverLog.info(`[subsonic] scrobble user=${user.username} track=${id}`);
        return send(c, {});
      }

      case "getlyrics": {
        // 经典歌词端点：优先按 id 查 track，其次按 artist+title 模糊匹配
        let track: Track | undefined;
        if (q.id) track = getTracksByIds([q.id])[0];
        if (!track && (q.artist || q.title)) {
          const pseudo: Track = {
            id: `lyric-${q.title ?? ""}`,
            source: "local",
            title: q.title ?? "",
            duration: 0,
            artists: q.artist ? q.artist.split(/[/&,]/).map((n) => ({ name: n.trim() })).filter((a) => a.name) : [],
          };
          track = pseudo;
        }
        if (!track) return send(c, {}, { code: 10, message: "Missing id or artist/title" });
        const lyric = await fetchLyricForTrack(track);
        if (!lyric) return send(c, { lyrics: {} });
        // Subsonic 经典 getLyrics：value 内放原始 LRC 文本，synced 标记是否带时间戳
        const synced = /\[\d{1,2}:\d{1,2}/.test(lyric.main);
        return send(c, {
          lyrics: {
            artist: q.artist ?? firstArtist(track.artists),
            title: q.title ?? track.title,
            synced: synced ? "true" : "false",
            value: lyric.main,
          },
        });
      }

      case "getlyricsbysongid": {
        // 1.16.1+ 结构化歌词端点：解析 LRC 为 line 列表
        if (!q.id) return send(c, {}, { code: 10, message: "Missing id" });
        const track = getTracksByIds([q.id])[0];
        if (!track) return send(c, {}, { code: 70, message: "Song not found" });
        const lyric = await fetchLyricForTrack(track);
        if (!lyric) return send(c, { lyricsList: {} });
        const lines = parseLrc(lyric.main);
        if (lines.length === 0) {
          // 非同步歌词：整段作为单行
          return send(c, {
            lyricsList: {
              structuredLyrics: [
                {
                  lang: "und",
                  displayArtist: firstArtist(track.artists),
                  displayTitle: track.title,
                  synced: "false",
                  offset: 0,
                  line: [{ value: lyric.main }],
                },
              ],
            },
          });
        }
        return send(c, {
          lyricsList: {
            structuredLyrics: [
              {
                lang: "und",
                displayArtist: firstArtist(track.artists),
                displayTitle: track.title,
                synced: "true",
                offset: 0,
                line: lines.map((l) => ({ start: l.start, value: l.value })),
              },
            ],
          },
        });
      }

      case "getplaylists": {
        const pls = listPlaylists(user.id).map((p) => ({
          id: p.id,
          name: p.name,
          songCount: p.trackIds.length,
          duration: getTracksByIds(p.trackIds).reduce((s, t) => s + Math.round(t.duration), 0),
          public: p.public,
          created: new Date(p.createdAt).toISOString(),
          changed: new Date(p.updatedAt).toISOString(),
          comment: p.comment ?? undefined,
          owner: user.username,
        }));
        return send(c, { playlists: { playlist: pls } });
      }

      case "getplaylist": {
        const pl = getPlaylist(q.id ?? "", user.id);
        if (!pl) return send(c, {}, { code: 70, message: "Playlist not found" });
        const tracks = getTracksByIds(pl.trackIds);
        return send(c, {
          playlist: {
            id: pl.id,
            name: pl.name,
            songCount: pl.trackIds.length,
            duration: tracks.reduce((s, t) => s + Math.round(t.duration), 0),
            public: pl.public,
            created: new Date(pl.createdAt).toISOString(),
            changed: new Date(pl.updatedAt).toISOString(),
            comment: pl.comment ?? undefined,
            owner: user.username,
            entry: tracks.map((t) => trackToChild(t, user.id)),
          },
        });
      }

      case "createplaylist": {
        const name = q.name ?? "Untitled";
        const ids = collectIds(q, "songId");
        const pl = createPlaylist(user.id, name, ids, { public: q.public === "true" });
        return send(c, { playlist: { id: pl.id, name: pl.name } });
      }

      case "updateplaylist": {
        const ids = collectIds(q, "songIdToAdd");
        if (q.name || q.comment || q.public) {
          updatePlaylist(q.id ?? "", user.id, {
            name: q.name,
            comment: q.comment,
            public: q.public === "true",
          });
        }
        if (ids.length) {
          const existing = getPlaylist(q.id ?? "", user.id);
          if (existing) updatePlaylist(q.id!, user.id, { trackIds: [...existing.trackIds, ...ids] });
        }
        return send(c, {});
      }

      case "deleteplaylist": {
        deletePlaylist(q.id ?? "", user.id);
        return send(c, {});
      }

      case "getshares": {
        const shares = listShares(user.id).map((s) => ({
          id: s.id,
          name: s.name,
          url: s.url,
          description: s.description ?? undefined,
          username: user.username,
          created: new Date(s.createdAt).toISOString(),
          expires: s.expiresAt ? new Date(s.expiresAt).toISOString() : undefined,
          visitCount: s.visitCount,
        }));
        return send(c, { shares: { share: shares } });
      }

      case "createshare": {
        const ids = collectIds(q, "id");
        const name = q.name ?? "Share";
        const baseUrl = `${c.req.header("x-forwarded-proto") ?? c.req.url.startsWith("https") ? "https" : "http"}://${c.req.header("host") ?? "localhost"}`;
        const share = createShare(user.id, name, ids, {
          description: q.description,
          expiresAt: q.expires ? new Date(q.expires).getTime() : undefined,
          baseUrl,
        });
        return send(c, { shares: { share: [{ id: share.id, name: share.name, url: share.url, visitCount: 0 }] } });
      }

      case "updateshare": {
        updateShare(q.id ?? "", user.id, {
          description: q.description,
          expiresAt: q.expires ? new Date(q.expires).getTime() : null,
        });
        return send(c, {});
      }

      case "deleteshare": {
        deleteShare(q.id ?? "", user.id);
        return send(c, {});
      }

      case "getgenres": {
        // 简化：返回空（SPlayer tracks 未持久化 genre）
        return send(c, { genres: { genre: [] } });
      }

      case "getusers": {
        const users = listUsers().map((u) => ({
          username: u.username,
          adminRole: u.isAdmin,
          settingsRole: u.isAdmin,
          downloadRole: true,
          uploadRole: false,
          playlistRole: true,
          coverArtRole: false,
          commentRole: true,
          podcastRole: false,
          streamRole: true,
          jukeboxRole: false,
          shareRole: true,
        }));
        return send(c, { users: { user: users } });
      }

      case "getuser": {
        const target = q.username ? listUsers().find((u) => u.username === q.username) : user;
        if (!target) return send(c, {}, { code: 70, message: "User not found" });
        return send(c, {
          user: {
            username: target.username,
            adminRole: target.isAdmin,
            settingsRole: target.isAdmin,
            downloadRole: true,
            uploadRole: false,
            playlistRole: true,
            coverArtRole: false,
            commentRole: true,
            podcastRole: false,
            streamRole: true,
            jukeboxRole: false,
            shareRole: true,
          },
        });
      }

      case "getnowplaying":
        return send(c, { nowPlaying: {} });

      case "gettopsongs":
        return send(c, { topSongs: { song: [] } });

      case "getsimilarartists":
      case "getsimilarartists2":
        return send(c, { [endpoint === "getsimilarartists2" ? "similarArtists2" : "similarArtists"]: { artist: [] } });

      case "getsongsbygenre":
        return send(c, { songsByGenre: { song: [] } });

      default:
        serverLog.warn(`[subsonic] 未实现的端点: ${endpoint}`);
        return send(c, {}, { code: 0, message: `Endpoint ${endpoint} not implemented` });
    }
  } catch (err) {
    serverLog.error(`[subsonic] ${endpoint} 失败:`, err);
    return send(c, {}, { code: 0, message: err instanceof Error ? err.message : "Internal error" });
  }
});

/* ------------------------------------------------------------------ */
/* 辅助：封面与流                                                      */
/* ------------------------------------------------------------------ */

/** 收集可能多值的 query 参数 */
const collectIds = (q: Record<string, string>, key: string): string[] => {
  const ids = q[key];
  if (!ids) return [];
  // Subsonic 多值用逗号分隔或重复参数
  return ids.split(",").map((s) => s.trim()).filter(Boolean);
};

/** 提供 coverArt：id 可能是 track/album/artist */
const serveCover = async (c: Context, id: string, size: number): Promise<Response> => {
  // 尝试按 track id 取封面缓存
  let coverPath = path.join(getCoverCacheDir(), `${id}.img`);

  // 若不是 track，找对应 album/artist 下第一个有封面的 track
  if (!existsSync(coverPath)) {
    let track: Track | undefined;
    const albumName = findAlbumNameById(id);
    if (albumName) {
      track = getAlbumTracks(albumName).find((t) => t.cover);
    } else {
      const artistName = findArtistNameById(id);
      if (artistName) track = getArtistTracks(artistName).find((t) => t.cover);
    }
    if (track) coverPath = path.join(getCoverCacheDir(), `${track.id}.img`);
  }

  if (!existsSync(coverPath)) {
    return c.body("cover not found", 404);
  }

  try {
    const pipeline = size > 0
      ? sharp(coverPath).resize(size, size, { fit: "inside", withoutEnlargement: true }).jpeg({ quality: 85 })
      : sharp(coverPath).jpeg({ quality: 90 });
    const buf = await pipeline.toBuffer();
    return new Response(buf, {
      status: 200,
      headers: { "Content-Type": "image/jpeg", "Cache-Control": "public, max-age=86400" },
    });
  } catch (err) {
    serverLog.warn(`[subsonic] 封面处理失败 ${id}:`, err);
    return c.body("cover error", 500);
  }
};

/** 提供音频流，支持 Range */
const serveStream = (c: Context, filePath: string, asDownload: boolean): Response => {
  const stat = statSync(filePath);
  const total = stat.size;
  const mime = mimeOf(filePath);
  const rangeHeader = c.req.header("range");

  if (!rangeHeader || asDownload) {
    const stream = Readable.toWeb(createReadStream(filePath)) as ReadableStream;
    const headers: Record<string, string> = {
      "Content-Type": mime,
      "Content-Length": String(total),
      "Accept-Ranges": "bytes",
      "Cache-Control": "public, max-age=3600",
    };
    if (asDownload) {
      headers["Content-Disposition"] = `attachment; filename="${path.basename(filePath)}"`;
    }
    return new Response(stream, { status: 200, headers });
  }

  const m = /bytes=(\d*)-(\d*)/.exec(rangeHeader);
  if (!m) return c.body("invalid range", 416);
  const start = m[1] ? parseInt(m[1], 10) : 0;
  const end = m[2] ? parseInt(m[2], 10) : total - 1;
  if (start > end || start >= total) {
    return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${total}` } });
  }
  const chunkSize = end - start + 1;
  const stream = Readable.toWeb(createReadStream(filePath, { start, end })) as ReadableStream;
  return new Response(stream, {
    status: 206,
    headers: {
      "Content-Type": mime,
      "Content-Length": String(chunkSize),
      "Content-Range": `bytes ${start}-${end}/${total}`,
      "Accept-Ranges": "bytes",
      "Cache-Control": "public, max-age=3600",
    },
  });
};

export default app;
