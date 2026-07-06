package db

import (
	"database/sql"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	_ "modernc.org/sqlite"

	"github.com/splayer/subsonic-go/crypto"
	"github.com/splayer/subsonic-go/model"
)

var pool *sql.DB

func defaultDataDir() string {
	if dataDir := os.Getenv("SPLAYER_DATA_DIR"); dataDir != "" {
		return dataDir
	}
	wd, err := os.Getwd()
	if err != nil {
		return filepath.Join(".", "data")
	}
	return filepath.Join(wd, "data")
}

// Open 打开 SQLite 数据库
//
// 使用 rw（读写）模式而非 ro（只读）：
// - ro 模式下无法设置 WAL journal mode，导致 TS 写进程阻塞 Go 读操作
// - rw 模式配合 busy_timeout，TS 写时 Go 读会等待而非挂死
func Open(dbPath string) error {
	dsn := fmt.Sprintf("file:%s?mode=rw&_journal_mode=WAL&_busy_timeout=10000", dbPath)
	var err error
	pool, err = sql.Open("sqlite", dsn)
	if err != nil {
		return fmt.Errorf("open db: %w", err)
	}
	// 单连接避免 WAL 读写竞争
	pool.SetMaxOpenConns(1)
	return pool.Ping()
}

// Close 关闭数据库
func Close() {
	if pool != nil {
		pool.Close()
	}
}

// DefaultDBPath 返回默认数据库路径
func DefaultDBPath() string {
	return filepath.Join(defaultDataDir(), "database", "library.db")
}

// CoverCacheDir 返回封面缓存目录
func CoverCacheDir() string {
	return filepath.Join(defaultDataDir(), "cache", "covers")
}

// MusicDir 返回音乐根目录
func MusicDir() string {
	if d := os.Getenv("SPLAYER_MUSIC_DIR"); d != "" {
		return d
	}
	return filepath.Join(defaultDataDir(), "music")
}

/* ------------------------------------------------------------------ */
/* 用户                                                                */
/* ------------------------------------------------------------------ */

// GetUserByUsername 按用户名查找（含密码解密）
func GetUserByUsername(username string) (*model.SubsonicUser, error) {
	var u model.SubsonicUser
	var passwordCipher string
	var isAdmin int
	err := pool.QueryRow(
		"SELECT id, username, password_cipher, is_admin, created_at FROM subsonic_users WHERE username = ?",
		username,
	).Scan(&u.ID, &u.Username, &passwordCipher, &isAdmin, &u.CreatedAt)
	if err != nil {
		return nil, err
	}
	u.IsAdmin = isAdmin == 1
	plain, err := crypto.DecryptString(passwordCipher)
	if err != nil {
		return nil, fmt.Errorf("decrypt password: %w", err)
	}
	u.Password = plain
	return &u, nil
}

// ListUsers 列出全部用户
func ListUsers() ([]model.SubsonicUser, error) {
	rows, err := pool.Query("SELECT id, username, password_cipher, is_admin, created_at FROM subsonic_users ORDER BY created_at")
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var users []model.SubsonicUser
	for rows.Next() {
		var u model.SubsonicUser
		var passwordCipher string
		var isAdmin int
		if err := rows.Scan(&u.ID, &u.Username, &passwordCipher, &isAdmin, &u.CreatedAt); err != nil {
			return nil, err
		}
		u.IsAdmin = isAdmin == 1
		plain, err := crypto.DecryptString(passwordCipher)
		if err == nil {
			u.Password = plain
		}
		users = append(users, u)
	}
	return users, nil
}

/* ------------------------------------------------------------------ */
/* 曲目查询                                                            */
/* ------------------------------------------------------------------ */

// scanSQLiteFloat64 兼容 SQLite 动态类型：float64 → int64
// SQLite 可能将整数存为 float64（例如大时间戳），Go sql.NullInt64 无法直接 Scan。
func scanSQLiteFloat64(val any) int64 {
	switch v := val.(type) {
	case int64:
		return v
	case float64:
		return int64(v)
	case nil:
		return 0
	}
	return 0
}

func scanTrack(row interface{ Scan(...any) error }) (model.Track, error) {
	var t model.Track
	var rawFileMtime, rawFileCtime any
	var rawSampleRate, rawBitRate, rawChannels, rawBitsPerSample any
	err := row.Scan(
		&t.ID, &t.Path, &t.Title, &t.TrackNo, &t.ArtistsJSON, &t.AlbumJSON,
		&t.Duration, &t.Cover, &t.Codec, &rawSampleRate, &rawBitRate,
		&rawChannels, &rawBitsPerSample, &t.FileSize, &rawFileMtime, &rawFileCtime,
		&t.ScannedAt, &t.Lyrics, &t.Genre,
	)
	if err != nil {
		return t, err
	}
	if rawSampleRate != nil {
		t.SampleRate = sql.NullInt64{Int64: scanSQLiteFloat64(rawSampleRate), Valid: true}
	}
	if rawBitRate != nil {
		t.BitRate = sql.NullInt64{Int64: scanSQLiteFloat64(rawBitRate), Valid: true}
	}
	if rawChannels != nil {
		t.Channels = sql.NullInt64{Int64: scanSQLiteFloat64(rawChannels), Valid: true}
	}
	if rawBitsPerSample != nil {
		t.BitsPerSample = sql.NullInt64{Int64: scanSQLiteFloat64(rawBitsPerSample), Valid: true}
	}
	if rawFileMtime != nil {
		t.FileMtime = sql.NullInt64{Int64: scanSQLiteFloat64(rawFileMtime), Valid: true}
	}
	if rawFileCtime != nil {
		t.FileCtime = sql.NullInt64{Int64: scanSQLiteFloat64(rawFileCtime), Valid: true}
	}
	return t, nil
}

const trackColumns = `id, path, title, track, artists, album, duration, cover,
	codec, sample_rate, bit_rate, channels, bits_per_sample,
	file_size, file_mtime, file_ctime, scanned_at, lyrics, genre`

// GetAllTracks 获取全部曲目
func GetAllTracks() ([]model.Track, error) {
	rows, err := pool.Query("SELECT " + trackColumns + " FROM tracks")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var tracks []model.Track
	for rows.Next() {
		t, err := scanTrack(rows)
		if err != nil {
			return nil, err
		}
		tracks = append(tracks, t)
	}
	return tracks, nil
}

// GetTracksPaginated 分页获取曲目（LIMIT + OFFSET）
func GetTracksPaginated(limit, offset int) ([]model.Track, error) {
	if limit <= 0 {
		limit = 100
	}
	if limit > 500 {
		limit = 500
	}
	if offset < 0 {
		offset = 0
	}
	rows, err := pool.Query("SELECT "+trackColumns+" FROM tracks ORDER BY id LIMIT ? OFFSET ?", limit, offset)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var tracks []model.Track
	for rows.Next() {
		t, err := scanTrack(rows)
		if err != nil {
			return nil, err
		}
		tracks = append(tracks, t)
	}
	return tracks, nil
}

// GetTrackCount 返回曲目总数
func GetTrackCount() (int, error) {
	var count int
	err := pool.QueryRow("SELECT COUNT(*) FROM tracks").Scan(&count)
	if err != nil {
		return 0, err
	}
	return count, nil
}

// RemoveDuplicatePaths 移除 path 列的重复行，保留 rowid 最小的那条
// 源于 C# 扫描器直接写入与 Node.js watcher HTTP 写入共用同一 SQLite 时，
// 可能因蓝图时序产生同 path 不同 id 的行。
func RemoveDuplicatePaths() (int, error) {
	// 先统计
	var dupCount int
	err := pool.QueryRow(`
		SELECT COUNT(*) - COUNT(DISTINCT path) FROM tracks
	`).Scan(&dupCount)
	if err != nil {
		return 0, err
	}
	if dupCount == 0 {
		return 0, nil
	}
	// 删除 path 重复的行，保留 rowid 最小的
	res, err := pool.Exec(`
		DELETE FROM tracks WHERE rowid NOT IN (
			SELECT MIN(rowid) FROM tracks GROUP BY path
		)
	`)
	if err != nil {
		return 0, err
	}
	n, _ := res.RowsAffected()
	return int(n), nil
}

// GetTrackByID 按 ID 获取单曲
func GetTrackByID(id string) (*model.Track, error) {
	row := pool.QueryRow("SELECT "+trackColumns+" FROM tracks WHERE id = ?", id)
	t, err := scanTrack(row)
	if err != nil {
		return nil, err
	}
	return &t, nil
}

// GetTracksByIDs 批量按 ID 获取
func GetTracksByIDs(ids []string) ([]model.Track, error) {
	if len(ids) == 0 {
		return nil, nil
	}
	placeholders := ""
	args := make([]any, len(ids))
	for i, id := range ids {
		if i > 0 {
			placeholders += ","
		}
		placeholders += "?"
		args[i] = id
	}
	rows, err := pool.Query("SELECT "+trackColumns+" FROM tracks WHERE id IN ("+placeholders+")", args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var tracks []model.Track
	for rows.Next() {
		t, err := scanTrack(rows)
		if err != nil {
			return nil, err
		}
		tracks = append(tracks, t)
	}
	return tracks, nil
}

// GetRandomTracks 随机取 N 首
func GetRandomTracks(limit int) ([]model.Track, error) {
	if limit <= 0 {
		return nil, nil
	}
	if limit > 500 {
		limit = 500
	}
	rows, err := pool.Query("SELECT "+trackColumns+" FROM tracks ORDER BY RANDOM() LIMIT ?", limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var tracks []model.Track
	for rows.Next() {
		t, err := scanTrack(rows)
		if err != nil {
			return nil, err
		}
		tracks = append(tracks, t)
	}
	return tracks, nil
}

// SearchTracks 模糊搜索
//
// artists/album 列为 JSON，INSTR 做字节级搜索兼容多字节 UTF-8。
func SearchTracks(query string) ([]model.Track, error) {
	pattern := "%" + query + "%"
	rows, err := pool.Query(
		`SELECT `+trackColumns+` FROM tracks
		 WHERE title LIKE ? ESCAPE '\'
		    OR INSTR(album, ?) > 0
		    OR INSTR(artists, ?) > 0`,
		pattern, query, query,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var tracks []model.Track
	for rows.Next() {
		t, err := scanTrack(rows)
		if err != nil {
			return nil, err
		}
		tracks = append(tracks, t)
	}
	return tracks, nil
}

// GetTrackLyrics 取内嵌歌词
func GetTrackLyrics(id string) (string, error) {
	var lyrics sql.NullString
	err := pool.QueryRow("SELECT lyrics FROM tracks WHERE id = ?", id).Scan(&lyrics)
	if err != nil {
		return "", err
	}
	if lyrics.Valid {
		return lyrics.String, nil
	}
	return "", nil
}

/* ------------------------------------------------------------------ */
/* 流派                                                                */
/* ------------------------------------------------------------------ */

// GenreSummary 流派摘要
type GenreSummary struct {
	Name       string
	TrackCount int
	AlbumCount int
}

// GetGenres 聚合 tracks.genre 列，返回非空流派及其歌曲/专辑数
// genre 列可能存储单个流派或以 ; / , / / 分隔的多个流派，做拆分处理
func GetGenres() ([]GenreSummary, error) {
	rows, err := pool.Query(`
		SELECT genre, COUNT(*) AS track_count,
		       COUNT(DISTINCT json_extract(album, '$.name')) AS album_count
		FROM tracks
		WHERE genre IS NOT NULL AND TRIM(genre) != ''
		GROUP BY genre`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	// 由于 genre 列可能含多个流派，先聚合原始值再拆分
	rawMap := make(map[string]*GenreSummary)
	for rows.Next() {
		var g string
		var tc, ac int
		if err := rows.Scan(&g, &tc, &ac); err != nil {
			return nil, err
		}
		for _, name := range splitGenres(g) {
			name = strings.TrimSpace(name)
			if name == "" {
				continue
			}
			if s, ok := rawMap[name]; ok {
				s.TrackCount += tc
				s.AlbumCount += ac
			} else {
				rawMap[name] = &GenreSummary{Name: name, TrackCount: tc, AlbumCount: ac}
			}
		}
	}

	list := make([]GenreSummary, 0, len(rawMap))
	for _, s := range rawMap {
		list = append(list, *s)
	}
	// 按歌曲数降序
	sort.Slice(list, func(i, j int) bool {
		return list[i].TrackCount > list[j].TrackCount
	})
	return list, nil
}

// splitGenres 拆分流派字符串（支持 ; , / 作为分隔符）
func splitGenres(s string) []string {
	out := []string{}
	s = strings.ReplaceAll(s, ";", "|")
	s = strings.ReplaceAll(s, ",", "|")
	s = strings.ReplaceAll(s, "/", "|")
	for _, p := range strings.Split(s, "|") {
		p = strings.TrimSpace(p)
		if p != "" {
			out = append(out, p)
		}
	}
	return out
}

// GetTracksByGenre 按 genre 模糊匹配获取曲目（支持分页）
func GetTracksByGenre(genre string, limit, offset int) ([]model.Track, error) {
	if limit <= 0 {
		limit = 10
	}
	if limit > 500 {
		limit = 500
	}
	if offset < 0 {
		offset = 0
	}
	pattern := "%" + genre + "%"
	rows, err := pool.Query(
		"SELECT "+trackColumns+" FROM tracks WHERE genre LIKE ? ORDER BY id LIMIT ? OFFSET ?",
		pattern, limit, offset)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var tracks []model.Track
	for rows.Next() {
		t, err := scanTrack(rows)
		if err != nil {
			return nil, err
		}
		tracks = append(tracks, t)
	}
	return tracks, nil
}

/* ------------------------------------------------------------------ */
/* 专辑/歌手聚合查询                                                    */
/* ------------------------------------------------------------------ */

// AlbumSummary 专辑摘要
type AlbumSummary struct {
	Name       string
	Cover      sql.NullString
	Artists    string
	TrackCount int
}

// ArtistSummary 歌手摘要
type ArtistSummary struct {
	Name       string
	TrackCount int
	Cover      sql.NullString
}

// GetAlbumList 获取专辑列表
func GetAlbumList() ([]AlbumSummary, error) {
	rows, err := pool.Query(`
		SELECT
			json_extract(album, '$.name') AS name,
			MAX(CASE WHEN cover IS NOT NULL THEN cover END) AS cover,
			MAX(artists) AS artists,
			COUNT(*) AS trackCount
		FROM tracks
		WHERE album IS NOT NULL AND json_extract(album, '$.name') IS NOT NULL
		GROUP BY name`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var list []AlbumSummary
	for rows.Next() {
		var a AlbumSummary
		if err := rows.Scan(&a.Name, &a.Cover, &a.Artists, &a.TrackCount); err != nil {
			return nil, err
		}
		list = append(list, a)
	}
	return list, nil
}

// GetArtistList 获取歌手列表
func GetArtistList() ([]ArtistSummary, error) {
	rows, err := pool.Query(`
		SELECT
			json_extract(a.value, '$.name') AS name,
			COUNT(DISTINCT t.id) AS trackCount,
			MAX(CASE WHEN t.cover IS NOT NULL THEN t.cover END) AS cover
		FROM tracks t, json_each(t.artists) a
		WHERE json_extract(a.value, '$.name') IS NOT NULL
			AND TRIM(json_extract(a.value, '$.name')) != ''
		GROUP BY name`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var list []ArtistSummary
	for rows.Next() {
		var a ArtistSummary
		if err := rows.Scan(&a.Name, &a.TrackCount, &a.Cover); err != nil {
			return nil, err
		}
		list = append(list, a)
	}
	return list, nil
}

// GetAlbumTracks 按专辑名获取全部曲目
func GetAlbumTracks(albumName string) ([]model.Track, error) {
	rows, err := pool.Query("SELECT "+trackColumns+" FROM tracks WHERE json_extract(album, '$.name') = ?", albumName)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var tracks []model.Track
	for rows.Next() {
		t, err := scanTrack(rows)
		if err != nil {
			return nil, err
		}
		tracks = append(tracks, t)
	}
	return tracks, nil
}

// GetArtistTracks 按歌手名获取全部曲目
func GetArtistTracks(artistName string) ([]model.Track, error) {
	rows, err := pool.Query(`
		SELECT DISTINCT t.id, t.path, t.title, t.track, t.artists, t.album,
			t.duration, t.cover, t.codec, t.sample_rate, t.bit_rate,
			t.channels, t.bits_per_sample, t.file_size, t.file_mtime, t.file_ctime,
			t.scanned_at, t.lyrics, t.genre
		FROM tracks t, json_each(t.artists) a
		WHERE LOWER(json_extract(a.value, '$.name')) = LOWER(?)`, artistName)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var tracks []model.Track
	for rows.Next() {
		t, err := scanTrack(rows)
		if err != nil {
			return nil, err
		}
		tracks = append(tracks, t)
	}
	return tracks, nil
}

/* ------------------------------------------------------------------ */
/* 收藏（starred）                                                     */
/* ------------------------------------------------------------------ */

// Star 收藏
func Star(userID, targetID string, targetType model.StarTargetType) error {
	_, err := pool.Exec(
		"INSERT OR IGNORE INTO subsonic_starred (user_id, target_id, target_type, starred_at) VALUES (?, ?, ?, ?)",
		userID, targetID, string(targetType), 0,
	)
	return err
}

// Unstar 取消收藏
func Unstar(userID, targetID string, targetType model.StarTargetType) error {
	_, err := pool.Exec(
		"DELETE FROM subsonic_starred WHERE user_id = ? AND target_id = ? AND target_type = ?",
		userID, targetID, string(targetType),
	)
	return err
}

// IsStarred 是否已收藏
func IsStarred(userID, targetID string, targetType model.StarTargetType) (bool, error) {
	var one int
	err := pool.QueryRow(
		"SELECT 1 FROM subsonic_starred WHERE user_id = ? AND target_id = ? AND target_type = ?",
		userID, targetID, string(targetType),
	).Scan(&one)
	if err == sql.ErrNoRows {
		return false, nil
	}
	return err == nil, err
}

// StarredIDs 用户全部收藏 ID
type StarredIDs struct {
	Tracks  []string
	Albums  []string
	Artists []string
}

func GetStarredIDs(userID string) (*StarredIDs, error) {
	rows, err := pool.Query(
		"SELECT target_id, target_type FROM subsonic_starred WHERE user_id = ?",
		userID,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := &StarredIDs{}
	for rows.Next() {
		var targetID, targetType string
		if err := rows.Scan(&targetID, &targetType); err != nil {
			return nil, err
		}
		switch model.StarTargetType(targetType) {
		case model.StarTrack:
			result.Tracks = append(result.Tracks, targetID)
		case model.StarAlbum:
			result.Albums = append(result.Albums, targetID)
		case model.StarArtist:
			result.Artists = append(result.Artists, targetID)
		}
	}
	return result, nil
}

/* ------------------------------------------------------------------ */
/* 播放列表                                                             */
/* ------------------------------------------------------------------ */

func ListPlaylists(userID string) ([]model.Playlist, error) {
	rows, err := pool.Query(
		"SELECT id, user_id, name, comment, public, created_at, updated_at FROM subsonic_playlists WHERE user_id = ? OR public = 1 ORDER BY updated_at DESC",
		userID,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var list []model.Playlist
	for rows.Next() {
		var p model.Playlist
		var isPublic int
		if err := rows.Scan(&p.ID, &p.UserID, &p.Name, &p.Comment, &isPublic, &p.CreatedAt, &p.UpdatedAt); err != nil {
			return nil, err
		}
		p.Public = isPublic == 1
		// 加载 entries
		entryRows, err := pool.Query(
			"SELECT track_id FROM subsonic_playlist_entries WHERE playlist_id = ? ORDER BY position",
			p.ID,
		)
		if err != nil {
			return nil, err
		}
		for entryRows.Next() {
			var tid string
			entryRows.Scan(&tid)
			p.TrackIDs = append(p.TrackIDs, tid)
		}
		entryRows.Close()
		list = append(list, p)
	}
	return list, nil
}

func GetPlaylist(id, userID string) (*model.Playlist, error) {
	var p model.Playlist
	var isPublic int
	err := pool.QueryRow(
		"SELECT id, user_id, name, comment, public, created_at, updated_at FROM subsonic_playlists WHERE id = ? AND (user_id = ? OR public = 1)",
		id, userID,
	).Scan(&p.ID, &p.UserID, &p.Name, &p.Comment, &isPublic, &p.CreatedAt, &p.UpdatedAt)
	if err != nil {
		return nil, err
	}
	p.Public = isPublic == 1
	rows, err := pool.Query(
		"SELECT track_id FROM subsonic_playlist_entries WHERE playlist_id = ? ORDER BY position",
		id,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var tid string
		rows.Scan(&tid)
		p.TrackIDs = append(p.TrackIDs, tid)
	}
	return &p, nil
}

/* ------------------------------------------------------------------ */
/* 分享                                                                */
/* ------------------------------------------------------------------ */

func ListShares(userID string) ([]model.Share, error) {
	rows, err := pool.Query(
		"SELECT id, user_id, name, description, url, expires_at, created_at, visit_count FROM subsonic_shares WHERE user_id = ? ORDER BY created_at DESC",
		userID,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var list []model.Share
	for rows.Next() {
		var s model.Share
		if err := rows.Scan(&s.ID, &s.UserID, &s.Name, &s.Description, &s.URL, &s.ExpiresAt, &s.CreatedAt, &s.VisitCount); err != nil {
			return nil, err
		}
		entryRows, err := pool.Query("SELECT track_id FROM subsonic_share_entries WHERE share_id = ?", s.ID)
		if err != nil {
			return nil, err
		}
		for entryRows.Next() {
			var tid string
			entryRows.Scan(&tid)
			s.TrackIDs = append(s.TrackIDs, tid)
		}
		entryRows.Close()
		list = append(list, s)
	}
	return list, nil
}

// CreatePlaylist 创建播放列表，返回新 ID
// playlistID 由调用方传入（通常为 uuid），便于事务一致性
func CreatePlaylist(playlistID, userID, name string, comment sql.NullString, public bool, trackIDs []string) error {
	now := nowMs()
	isPublic := 0
	if public {
		isPublic = 1
	}
	tx, err := pool.Begin()
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()

	if _, err := tx.Exec(
		"INSERT INTO subsonic_playlists (id, user_id, name, comment, public, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
		playlistID, userID, name, comment, isPublic, now, now,
	); err != nil {
		return err
	}

	for i, tid := range trackIDs {
		if _, err := tx.Exec(
			"INSERT INTO subsonic_playlist_entries (playlist_id, track_id, position) VALUES (?, ?, ?)",
			playlistID, tid, i,
		); err != nil {
			return err
		}
	}

	return tx.Commit()
}

// UpdatePlaylist 更新播放列表（任意字段为空/nil 表示不更新）
// trackIDsToAdd 追加到末尾；trackIndexesToRemove 删除指定位置（0-based）的条目
func UpdatePlaylist(id, name string, comment sql.NullString, public *bool, trackIDsToAdd []string, trackIndexesToRemove []int) error {
	tx, err := pool.Begin()
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()

	if name != "" {
		if _, err := tx.Exec("UPDATE subsonic_playlists SET name = ?, updated_at = ? WHERE id = ?", name, nowMs(), id); err != nil {
			return err
		}
	}
	if comment.Valid {
		if _, err := tx.Exec("UPDATE subsonic_playlists SET comment = ?, updated_at = ? WHERE id = ?", comment.String, nowMs(), id); err != nil {
			return err
		}
	}
	if public != nil {
		isPublic := 0
		if *public {
			isPublic = 1
		}
		if _, err := tx.Exec("UPDATE subsonic_playlists SET public = ?, updated_at = ? WHERE id = ?", isPublic, nowMs(), id); err != nil {
			return err
		}
	}

	// 删除指定位置条目（倒序删除避免索引漂移）
	if len(trackIndexesToRemove) > 0 {
		// 收集现有位置
		rows, err := tx.Query("SELECT rowid FROM subsonic_playlist_entries WHERE playlist_id = ? ORDER BY position", id)
		if err != nil {
			return err
		}
		var rowids []int64
		for rows.Next() {
			var rid int64
			rows.Scan(&rid)
			rowids = append(rowids, rid)
		}
		rows.Close()
		// 倒序删除
		sorted := append([]int(nil), trackIndexesToRemove...)
		sort.Sort(sort.Reverse(sort.IntSlice(sorted)))
		for _, idx := range sorted {
			if idx >= 0 && idx < len(rowids) {
				if _, err := tx.Exec("DELETE FROM subsonic_playlist_entries WHERE rowid = ?", rowids[idx]); err != nil {
					return err
				}
			}
		}
		// 重新编号 position
		if _, err := tx.Exec(`
			UPDATE subsonic_playlist_entries
			SET position = (
				SELECT COUNT(*) FROM subsonic_playlist_entries AS t2
				WHERE t2.playlist_id = subsonic_playlist_entries.playlist_id
				  AND t2.rowid < subsonic_playlist_entries.rowid
			)
			WHERE playlist_id = ?
		`, id); err != nil {
			return err
		}
	}

	// 追加新条目
	if len(trackIDsToAdd) > 0 {
		var maxPos sql.NullInt64
		_ = tx.QueryRow("SELECT MAX(position) FROM subsonic_playlist_entries WHERE playlist_id = ?", id).Scan(&maxPos)
		startPos := 0
		if maxPos.Valid {
			startPos = int(maxPos.Int64) + 1
		}
		for i, tid := range trackIDsToAdd {
			if _, err := tx.Exec(
				"INSERT INTO subsonic_playlist_entries (playlist_id, track_id, position) VALUES (?, ?, ?)",
				id, tid, startPos+i,
			); err != nil {
				return err
			}
		}
		if _, err := tx.Exec("UPDATE subsonic_playlists SET updated_at = ? WHERE id = ?", nowMs(), id); err != nil {
			return err
		}
	}

	return tx.Commit()
}

// DeletePlaylist 删除播放列表及其条目
func DeletePlaylist(id string) error {
	tx, err := pool.Begin()
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()

	if _, err := tx.Exec("DELETE FROM subsonic_playlist_entries WHERE playlist_id = ?", id); err != nil {
		return err
	}
	if _, err := tx.Exec("DELETE FROM subsonic_playlists WHERE id = ?", id); err != nil {
		return err
	}
	return tx.Commit()
}

/* ------------------------------------------------------------------ */
/* 分享 CRUD                                                            */
/* ------------------------------------------------------------------ */

// CreateShare 创建分享，返回新 ID（由调用方传入）
func CreateShare(shareID, userID, name string, description sql.NullString, url string, expiresAt sql.NullInt64, trackIDs []string) error {
	now := nowMs()
	tx, err := pool.Begin()
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()

	if _, err := tx.Exec(
		"INSERT INTO subsonic_shares (id, user_id, name, description, url, expires_at, created_at, visit_count) VALUES (?, ?, ?, ?, ?, ?, ?, 0)",
		shareID, userID, name, description, url, expiresAt, now,
	); err != nil {
		return err
	}

	for i, tid := range trackIDs {
		if _, err := tx.Exec(
			"INSERT INTO subsonic_share_entries (share_id, track_id, position) VALUES (?, ?, ?)",
			shareID, tid, i,
		); err != nil {
			return err
		}
	}

	return tx.Commit()
}

// UpdateShare 更新分享（空值不更新）
func UpdateShare(id, name string, description sql.NullString, expiresAt sql.NullInt64) error {
	tx, err := pool.Begin()
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()

	if name != "" {
		if _, err := tx.Exec("UPDATE subsonic_shares SET name = ? WHERE id = ?", name, id); err != nil {
			return err
		}
	}
	if description.Valid {
		if _, err := tx.Exec("UPDATE subsonic_shares SET description = ? WHERE id = ?", description.String, id); err != nil {
			return err
		}
	}
	if expiresAt.Valid {
		if _, err := tx.Exec("UPDATE subsonic_shares SET expires_at = ? WHERE id = ?", expiresAt.Int64, id); err != nil {
			return err
		}
	}
	return tx.Commit()
}

// DeleteShare 删除分享及其条目
func DeleteShare(id string) error {
	tx, err := pool.Begin()
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()

	if _, err := tx.Exec("DELETE FROM subsonic_share_entries WHERE share_id = ?", id); err != nil {
		return err
	}
	if _, err := tx.Exec("DELETE FROM subsonic_shares WHERE id = ?", id); err != nil {
		return err
	}
	return tx.Commit()
}

/* ------------------------------------------------------------------ */
/* 扫描状态                                                             */
/* ------------------------------------------------------------------ */

// GetLastScanTime 返回 tracks 表中最大的 scanned_at（毫秒），0 表示无数据
func GetLastScanTime() (int64, error) {
	var t sql.NullInt64
	err := pool.QueryRow("SELECT MAX(scanned_at) FROM tracks").Scan(&t)
	if err != nil {
		return 0, err
	}
	if !t.Valid {
		return 0, nil
	}
	return t.Int64, nil
}

// nowMs 当前毫秒时间戳
func nowMs() int64 {
	return time.Now().UnixMilli()
}
