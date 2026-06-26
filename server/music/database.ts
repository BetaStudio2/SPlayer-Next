/**
 * 曲库 CRUD 门面：从 @main/database 转发 track 相关查询，
 * 供 routes/music 与 watcher / scanner 统一引用。
 */
export {
  getAllTracks,
  getTrackCount,
  getFileRecords,
  upsertTracks,
  deleteTracksByPaths,
  deleteTracksByDir,
  searchTracks,
  getAlbumList,
  getArtistList,
  getAlbumTracks,
  getArtistTracks,
  getTracksByIds,
  getRandomTrack,
  getRandomTracks,
} from "@main/database";
export type { FileRecord, UpsertTrack } from "@main/database";
