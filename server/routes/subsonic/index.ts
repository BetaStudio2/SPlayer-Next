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
 */
import { Hono } from "hono";
import { existsSync } from "node:fs";
import {
  listUsers,
  star,
  unstar,
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
  getRandomTracks,
} from "@main/database";
import { serverLog } from "@main/utils/logger";
import { authMiddleware } from "./auth";
import { fetchLyricForTrack, prepareSubsonicLyric } from "./lyrics";
import {
  send,
  serveCover,
  serveStream,
  trackToChild,
  trackToSong,
  albumListRowToAlbum,
  artistListRowToArtist,
  parseIntOr,
  collectIds,
  OPEN_SUBSONIC_EXTENSIONS,
} from "./helpers";
import type { Track } from "@shared/types/player";
import type { AlbumSummary, ArtistSummary } from "@shared/types/library";

const app = new Hono();

/** 鉴权中间件（挂到所有路由前） */
app.all("/*", authMiddleware);

/* ------------------------------------------------------------------ */
/* 成对端点 key 映射（逻辑相同，仅返回 key 不同）                         */
/* ------------------------------------------------------------------ */

const ENDPOINT_KEY_MAP: Record<string, string> = {
  getalbumlist: "albumList",
  getalbumlist2: "albumList2",
  getstarred: "starred",
  getstarred2: "starred2",
  search2: "searchResult2",
  search3: "searchResult3",
  getsimilarartists: "similarArtists",
  getsimilarartists2: "similarArtists2",
};

/* ------------------------------------------------------------------ */
/* 端点分发                                                            */
/* ------------------------------------------------------------------ */

app.all("/*", async (c) => {
  // 解析端点名：取路径最后一段（去掉 .view 后缀）
  // 兼容客户端把 /rest 也填入"服务器地址"导致的 /rest/rest/<endpoint> 双重前缀
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

      case "getopensubsonicextensions":
        return send(c, { openSubsonicExtensions: OPEN_SUBSONIC_EXTENSIONS });

      case "getlicense":
        return send(c, { license: { valid: true, email: "splayer@local", licenseExpires: "2099-01-01" } });

      case "getmusicfolders":
        return send(c, { musicFolders: { musicFolder: [{ id: 0, name: "Music" }] } });

      case "getindexes":
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
        const key = endpoint === "getartists" ? "artists" : "indexes";
        return send(c, { [key]: { ignoredArticles: "The El", index } });
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
            artist: tracks[0] ? tracks[0].artists.map((a) => a.name).join(" / ") : "",
            artistId: tracks[0] ? artistIdOf(tracks[0].artists[0]?.name ?? "") : undefined,
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
        let list = [...getAlbumList()];
        if (type === "newest" || type === "recent") {
          list.sort((a, b) => {
            const aTime = getAlbumTracks(a.name)[0]?.ctime ?? 0;
            const bTime = getAlbumTracks(b.name)[0]?.ctime ?? 0;
            return bTime - aTime;
          });
        } else if (type === "frequent") {
          list.sort((a, b) => b.trackCount - a.trackCount);
        } else if (type === "random") {
          list.sort(() => Math.random() - 0.5);
        } else if (type === "alphabeticalByName") {
          list.sort((a, b) => a.name.localeCompare(b.name));
        } else if (type === "alphabeticalByArtist") {
          list.sort((a, b) => a.artist.localeCompare(b.artist));
        } else {
          list.sort((a, b) => a.name.localeCompare(b.name));
        }
        list = list.slice(offset, offset + size);
        const key = ENDPOINT_KEY_MAP[endpoint] ?? "albumList";
        return send(c, { [key]: { album: list.map((r) => albumListRowToAlbum(r)) } });
      }

      case "getsong": {
        const track = getTracksByIds([q.id ?? ""])[0];
        if (!track) return send(c, {}, { code: 70, message: "Song not found" });
        return send(c, { song: trackToSong(track, user.id) });
      }

      case "getrandomsongs": {
        const size = Math.min(parseInt(q.size ?? "10", 10) || 10, 500);
        return send(c, { randomSongs: { song: getRandomTracks(size).map((t) => trackToSong(t, user.id)) } });
      }

      case "getcoverart": {
        return serveCover(c, q.id ?? "", q.size ? parseInt(q.size, 10) : 0);
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
              artist: at[0] ? at[0].artists.map((a) => a.name).join(" / ") : "",
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
        const key = ENDPOINT_KEY_MAP[endpoint] ?? "searchResult2";
        return send(c, { [key]: result });
      }

      case "getstarred":
      case "getstarred2": {
        const starred = getStarredIds(user.id);
        const songs = getTracksByIds(starred.tracks).map((t) => trackToSong(t, user.id));
        const albums = starred.albums
          .map((id) => findAlbumNameById(id))
          .filter((n): n is string => !!n)
          .map((name) => albumListRowToAlbum(getAlbumList().find((a) => a.name === name)!));
        const artists = starred.artists
          .map((id) => findArtistNameById(id))
          .filter((n): n is string => !!n)
          .map((name) => artistListRowToArtist(getArtistList().find((a) => a.name === name)!));
        const key = ENDPOINT_KEY_MAP[endpoint] ?? "starred";
        return send(c, { [key]: { song: songs, album: albums, artist: artists } });
      }

      case "star": {
        for (const id of collectIds(q, "id")) star(user.id, id, "track");
        for (const id of collectIds(q, "albumId")) star(user.id, id, "album");
        for (const id of collectIds(q, "artistId")) star(user.id, id, "artist");
        return send(c, {});
      }

      case "unstar": {
        for (const id of collectIds(q, "id")) unstar(user.id, id, "track");
        for (const id of collectIds(q, "albumId")) unstar(user.id, id, "album");
        for (const id of collectIds(q, "artistId")) unstar(user.id, id, "artist");
        return send(c, {});
      }

      case "scrobble": {
        serverLog.info(`[subsonic] scrobble user=${user.username} track=${q.id ?? ""}`);
        return send(c, {});
      }

      case "getlyrics": {
        let track: Track | undefined;
        if (q.id) track = getTracksByIds([q.id])[0];
        if (!track && (q.artist || q.title)) {
          track = {
            id: `lyric-${q.title ?? ""}`,
            source: "local",
            title: q.title ?? "",
            duration: 0,
            artists: q.artist ? q.artist.split(/[/&,]/).map((n) => ({ name: n.trim() })).filter((a) => a.name) : [],
          };
        }
        if (!track) return send(c, {}, { code: 10, message: "Missing id or artist/title" });
        const lyric = await fetchLyricForTrack(track);
        if (!lyric) return send(c, { lyrics: {} });
        const prepared = prepareSubsonicLyric(lyric);
        return send(c, {
          lyrics: {
            artist: q.artist ?? track.artists.map((a) => a.name).join(" / "),
            title: q.title ?? track.title,
            synced: prepared.synced ? "true" : "false",
            value: prepared.classicText,
          },
        });
      }

      case "getlyricsbysongid": {
        if (!q.id) return send(c, {}, { code: 10, message: "Missing id" });
        const track = getTracksByIds([q.id])[0];
        if (!track) return send(c, {}, { code: 70, message: "Song not found" });
        const lyric = await fetchLyricForTrack(track);
        if (!lyric) return send(c, { lyricsList: {} });
        const prepared = prepareSubsonicLyric(lyric);
        if (prepared.structuredLines.length === 0) return send(c, { lyricsList: {} });
        return send(c, {
          lyricsList: {
            structuredLyrics: [
              {
                lang: "und",
                displayArtist: track.artists.map((a) => a.name).join(" / "),
                displayTitle: track.title,
                synced: prepared.synced ? "true" : "false",
                offset: 0,
                line: prepared.structuredLines.map((l) => ({ start: l.start, value: l.value })),
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
        const pl = createPlaylist(user.id, name, collectIds(q, "songId"), { public: q.public === "true" });
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

      case "getgenres":
        return send(c, { genres: { genre: [] } });

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
      case "getsimilarartists2": {
        const key = ENDPOINT_KEY_MAP[endpoint] ?? "similarArtists";
        return send(c, { [key]: { artist: [] } });
      }

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

export default app;
