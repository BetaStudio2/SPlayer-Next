/**
 * Subsonic 服务端数据访问层
 *
 * SPlayer 的 tracks 表是扁平结构（album/artist 以 JSON 嵌在 track 行里），
 * 没有 Navidrome 那样的独立 album/artist 表。因此：
 *   - track id   = tracks.id（原生）
 *   - album id   = md5(album.name) 的 hex
 *   - artist id  = md5(artist.name) 的 hex
 *
 * 反查 album/artist 时遍历名称集合匹配 md5（曲库规模下可接受）。
 */
import { createHash, randomUUID } from "node:crypto";
import { encryptString, decryptString } from "@main/utils/crypto";
import { getDb } from "./index";
import {
  getAllTracks,
  getAlbumList,
  getArtistList,
  getAlbumTracks,
  getArtistTracks,
  searchTracks,
  getTracksByIds,
  getRandomTracks,
} from "./queries";
import type { Track } from "@shared/types/player";

/** 计算 album/artist 稳定 ID */
export const albumIdOf = (name: string): string =>
  createHash("md5").update(name).digest("hex");
export const artistIdOf = (name: string): string =>
  createHash("md5").update(name).digest("hex");

/* ------------------------------------------------------------------ */
/* 用户管理                                                             */
/* ------------------------------------------------------------------ */

export interface SubsonicUser {
  id: string;
  username: string;
  password: string; // 明文（仅运行时，落盘为密文）
  isAdmin: boolean;
  createdAt: number;
}

interface UserRow {
  id: string;
  username: string;
  password_cipher: string;
  is_admin: number;
  created_at: number;
}

const rowToUser = (row: UserRow): SubsonicUser => ({
  id: row.id,
  username: row.username,
  password: decryptString(row.password_cipher),
  isAdmin: row.is_admin === 1,
  createdAt: row.created_at,
});

/** 列出全部用户 */
export const listUsers = (): SubsonicUser[] => {
  const rows = getDb().prepare("SELECT * FROM subsonic_users ORDER BY created_at").all() as UserRow[];
  return rows.map(rowToUser);
};

/** 按用户名查找 */
export const getUserByUsername = (username: string): SubsonicUser | null => {
  const row = getDb()
    .prepare("SELECT * FROM subsonic_users WHERE username = ?")
    .get(username) as UserRow | undefined;
  return row ? rowToUser(row) : null;
};

export interface CreateUserInput {
  username: string;
  password: string;
  isAdmin?: boolean;
}

/** 创建用户（用户名唯一） */
export const createUser = (input: CreateUserInput): SubsonicUser => {
  const existing = getUserByUsername(input.username);
  if (existing) throw new Error("username already exists");
  const user: SubsonicUser = {
    id: randomUUID(),
    username: input.username,
    password: input.password,
    isAdmin: input.isAdmin ?? false,
    createdAt: Date.now(),
  };
  getDb()
    .prepare(
      "INSERT INTO subsonic_users (id, username, password_cipher, is_admin, created_at) VALUES (?, ?, ?, ?, ?)",
    )
    .run(user.id, user.username, encryptString(user.password), user.isAdmin ? 1 : 0, user.createdAt);
  return user;
};

export interface UpdateUserInput {
  password?: string;
  isAdmin?: boolean;
}

/** 更新用户（密码可选，为空则不改） */
export const updateUser = (id: string, input: UpdateUserInput): void => {
  const sets: string[] = [];
  const params: (string | number)[] = [];
  if (input.password != null && input.password !== "") {
    sets.push("password_cipher = ?");
    params.push(encryptString(input.password));
  }
  if (input.isAdmin != null) {
    sets.push("is_admin = ?");
    params.push(input.isAdmin ? 1 : 0);
  }
  if (sets.length === 0) return;
  params.push(id);
  getDb().prepare(`UPDATE subsonic_users SET ${sets.join(", ")} WHERE id = ?`).run(...params);
};

/** 删除用户（同时清理关联数据） */
export const deleteUser = (id: string): void => {
  const d = getDb();
  const tx = d.transaction(() => {
    d.prepare("DELETE FROM subsonic_starred WHERE user_id = ?").run(id);
    d.prepare("DELETE FROM subsonic_playlist_entries WHERE playlist_id IN (SELECT id FROM subsonic_playlists WHERE user_id = ?)").run(id);
    d.prepare("DELETE FROM subsonic_playlists WHERE user_id = ?").run(id);
    d.prepare("DELETE FROM subsonic_share_entries WHERE share_id IN (SELECT id FROM subsonic_shares WHERE user_id = ?)").run(id);
    d.prepare("DELETE FROM subsonic_shares WHERE user_id = ?").run(id);
    d.prepare("DELETE FROM subsonic_users WHERE id = ?").run(id);
  });
  tx();
};

/* ------------------------------------------------------------------ */
/* 收藏（starred）多用户隔离                                            */
/* ------------------------------------------------------------------ */

export type StarTargetType = "track" | "album" | "artist";

export const star = (userId: string, targetId: string, type: StarTargetType): void => {
  getDb()
    .prepare(
      "INSERT OR IGNORE INTO subsonic_starred (user_id, target_id, target_type, starred_at) VALUES (?, ?, ?, ?)",
    )
    .run(userId, targetId, type, Date.now());
};

export const unstar = (userId: string, targetId: string, type: StarTargetType): void => {
  getDb()
    .prepare(
      "DELETE FROM subsonic_starred WHERE user_id = ? AND target_id = ? AND target_type = ?",
    )
    .run(userId, targetId, type);
};

export const isStarred = (userId: string, targetId: string, type: StarTargetType): boolean => {
  const row = getDb()
    .prepare(
      "SELECT 1 FROM subsonic_starred WHERE user_id = ? AND target_id = ? AND target_type = ?",
    )
    .get(userId, targetId, type);
  return row !== undefined;
};

export interface StarredIds {
  tracks: string[];
  albums: string[];
  artists: string[];
}

/** 获取用户全部收藏 ID */
export const getStarredIds = (userId: string): StarredIds => {
  const rows = getDb()
    .prepare("SELECT target_id, target_type FROM subsonic_starred WHERE user_id = ?")
    .all(userId) as { target_id: string; target_type: StarTargetType }[];
  const result: StarredIds = { tracks: [], albums: [], artists: [] };
  for (const r of rows) {
    if (r.target_type === "track") result.tracks.push(r.target_id);
    else if (r.target_type === "album") result.albums.push(r.target_id);
    else result.artists.push(r.target_id);
  }
  return result;
};

/* ------------------------------------------------------------------ */
/* 播放列表                                                            */
/* ------------------------------------------------------------------ */

export interface SubsonicPlaylist {
  id: string;
  userId: string;
  name: string;
  comment: string | null;
  public: boolean;
  createdAt: number;
  updatedAt: number;
  trackIds: string[];
}

interface PlaylistRow {
  id: string;
  user_id: string;
  name: string;
  comment: string | null;
  public: number;
  created_at: number;
  updated_at: number;
}

const playlistRowToObj = (row: PlaylistRow, trackIds: string[]): SubsonicPlaylist => ({
  id: row.id,
  userId: row.user_id,
  name: row.name,
  comment: row.comment,
  public: row.public === 1,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  trackIds,
});

export const listPlaylists = (userId: string): SubsonicPlaylist[] => {
  const rows = getDb()
    .prepare("SELECT * FROM subsonic_playlists WHERE user_id = ? OR public = 1 ORDER BY updated_at DESC")
    .all(userId) as PlaylistRow[];
  return rows.map((row) => {
    const ids = getDb()
      .prepare("SELECT track_id FROM subsonic_playlist_entries WHERE playlist_id = ? ORDER BY position")
      .all(row.id) as { track_id: string }[];
    return playlistRowToObj(row, ids.map((r) => r.track_id));
  });
};

export const getPlaylist = (id: string, userId: string): SubsonicPlaylist | null => {
  const row = getDb()
    .prepare("SELECT * FROM subsonic_playlists WHERE id = ? AND (user_id = ? OR public = 1)")
    .get(id, userId) as PlaylistRow | undefined;
  if (!row) return null;
  const ids = getDb()
    .prepare("SELECT track_id FROM subsonic_playlist_entries WHERE playlist_id = ? ORDER BY position")
    .all(id) as { track_id: string }[];
  return playlistRowToObj(row, ids.map((r) => r.track_id));
};

export const createPlaylist = (
  userId: string,
  name: string,
  trackIds: string[],
  opts: { comment?: string; public?: boolean } = {},
): SubsonicPlaylist => {
  const now = Date.now();
  const pl: SubsonicPlaylist = {
    id: randomUUID(),
    userId,
    name,
    comment: opts.comment ?? null,
    public: opts.public ?? false,
    createdAt: now,
    updatedAt: now,
    trackIds,
  };
  const d = getDb();
  const tx = d.transaction(() => {
    d.prepare(
      "INSERT INTO subsonic_playlists (id, user_id, name, comment, public, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run(pl.id, pl.userId, pl.name, pl.comment, pl.public ? 1 : 0, pl.createdAt, pl.updatedAt);
    const stmt = d.prepare(
      "INSERT INTO subsonic_playlist_entries (playlist_id, track_id, position) VALUES (?, ?, ?)",
    );
    pl.trackIds.forEach((tid, i) => stmt.run(pl.id, tid, i));
  });
  tx();
  return pl;
};

export const updatePlaylist = (
  id: string,
  userId: string,
  input: { name?: string; comment?: string; public?: boolean; trackIds?: string[] },
): void => {
  const existing = getPlaylist(id, userId);
  if (!existing) throw new Error("playlist not found");
  const d = getDb();
  const now = Date.now();
  const tx = d.transaction(() => {
    const sets: string[] = ["updated_at = ?"];
    const params: (string | number)[] = [now];
    if (input.name != null) { sets.push("name = ?"); params.push(input.name); }
    if (input.comment != null) { sets.push("comment = ?"); params.push(input.comment); }
    if (input.public != null) { sets.push("public = ?"); params.push(input.public ? 1 : 0); }
    params.push(id);
    d.prepare(`UPDATE subsonic_playlists SET ${sets.join(", ")} WHERE id = ?`).run(...params);
    if (input.trackIds != null) {
      d.prepare("DELETE FROM subsonic_playlist_entries WHERE playlist_id = ?").run(id);
      const stmt = d.prepare(
        "INSERT INTO subsonic_playlist_entries (playlist_id, track_id, position) VALUES (?, ?, ?)",
      );
      input.trackIds.forEach((tid, i) => stmt.run(id, tid, i));
    }
  });
  tx();
};

export const deletePlaylist = (id: string, userId: string): void => {
  const d = getDb();
  const tx = d.transaction(() => {
    d.prepare("DELETE FROM subsonic_playlist_entries WHERE playlist_id = ?").run(id);
    d.prepare("DELETE FROM subsonic_playlists WHERE id = ? AND user_id = ?").run(id, userId);
  });
  tx();
};

/* ------------------------------------------------------------------ */
/* 分享                                                                */
/* ------------------------------------------------------------------ */

export interface SubsonicShare {
  id: string;
  userId: string;
  name: string;
  description: string | null;
  url: string;
  expiresAt: number | null;
  createdAt: number;
  visitCount: number;
  trackIds: string[];
}

interface ShareRow {
  id: string;
  user_id: string;
  name: string;
  description: string | null;
  url: string;
  expires_at: number | null;
  created_at: number;
  visit_count: number;
}

const shareRowToObj = (row: ShareRow, trackIds: string[]): SubsonicShare => ({
  id: row.id,
  userId: row.user_id,
  name: row.name,
  description: row.description,
  url: row.url,
  expiresAt: row.expires_at,
  createdAt: row.created_at,
  visitCount: row.visit_count,
  trackIds,
});

export const listShares = (userId: string): SubsonicShare[] => {
  const rows = getDb()
    .prepare("SELECT * FROM subsonic_shares WHERE user_id = ? ORDER BY created_at DESC")
    .all(userId) as ShareRow[];
  return rows.map((row) => {
    const ids = getDb()
      .prepare("SELECT track_id FROM subsonic_share_entries WHERE share_id = ?")
      .all(row.id) as { track_id: string }[];
    return shareRowToObj(row, ids.map((r) => r.track_id));
  });
};

export const getShare = (id: string): SubsonicShare | null => {
  const row = getDb().prepare("SELECT * FROM subsonic_shares WHERE id = ?").get(id) as ShareRow | undefined;
  if (!row) return null;
  const ids = getDb()
    .prepare("SELECT track_id FROM subsonic_share_entries WHERE share_id = ?")
    .all(id) as { track_id: string }[];
  return shareRowToObj(row, ids.map((r) => r.track_id));
};

export const createShare = (
  userId: string,
  name: string,
  trackIds: string[],
  opts: { description?: string; expiresAt?: number; baseUrl?: string } = {},
): SubsonicShare => {
  const now = Date.now();
  const id = randomUUID();
  const baseUrl = opts.baseUrl ?? "";
  const share: SubsonicShare = {
    id,
    userId,
    name,
    description: opts.description ?? null,
    url: `${baseUrl}/ext/share/${id}`,
    expiresAt: opts.expiresAt ?? null,
    createdAt: now,
    visitCount: 0,
    trackIds,
  };
  const d = getDb();
  const tx = d.transaction(() => {
    d.prepare(
      "INSERT INTO subsonic_shares (id, user_id, name, description, url, expires_at, created_at, visit_count) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(share.id, share.userId, share.name, share.description, share.url, share.expiresAt, share.createdAt, 0);
    const stmt = d.prepare("INSERT INTO subsonic_share_entries (share_id, track_id) VALUES (?, ?)");
    share.trackIds.forEach((tid) => stmt.run(share.id, tid));
  });
  tx();
  return share;
};

export const updateShare = (
  id: string,
  userId: string,
  input: { description?: string; expiresAt?: number | null },
): void => {
  const sets: string[] = [];
  const params: (string | number | null)[] = [];
  if (input.description != null) { sets.push("description = ?"); params.push(input.description); }
  if (input.expiresAt !== undefined) { sets.push("expires_at = ?"); params.push(input.expiresAt); }
  if (sets.length === 0) return;
  params.push(id, userId);
  getDb().prepare(`UPDATE subsonic_shares SET ${sets.join(", ")} WHERE id = ? AND user_id = ?`).run(...params);
};

export const deleteShare = (id: string, userId: string): void => {
  const d = getDb();
  const tx = d.transaction(() => {
    d.prepare("DELETE FROM subsonic_share_entries WHERE share_id = ?").run(id);
    d.prepare("DELETE FROM subsonic_shares WHERE id = ? AND user_id = ?").run(id, userId);
  });
  tx();
};

export const incrementShareVisit = (id: string): void => {
  getDb().prepare("UPDATE subsonic_shares SET visit_count = visit_count + 1 WHERE id = ?").run(id);
};

/* ------------------------------------------------------------------ */
/* 曲库查询适配（基于现有 queries，附加 md5 id 映射）                    */
/* ------------------------------------------------------------------ */

/** 按 album id（md5）反查专辑名 */
export const findAlbumNameById = (id: string): string | null => {
  const albums = getAlbumList();
  for (const a of albums) {
    if (albumIdOf(a.name) === id) return a.name;
  }
  return null;
};

/** 按 artist id（md5）反查歌手名 */
export const findArtistNameById = (id: string): string | null => {
  const artists = getArtistList();
  for (const a of artists) {
    if (artistIdOf(a.name) === id) return a.name;
  }
  return null;
};

/** 获取全部曲目（透传） */
export { getAllTracks, getAlbumList, getArtistList, getAlbumTracks, getArtistTracks, searchTracks, getTracksByIds, getRandomTracks };
export type { Track };
