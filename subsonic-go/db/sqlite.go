package db

import (
	"database/sql"
	"fmt"
	"os"
	"path/filepath"

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
	err := row.Scan(
		&t.ID, &t.Path, &t.Title, &t.TrackNo, &t.ArtistsJSON, &t.AlbumJSON,
		&t.Duration, &t.Cover, &t.Codec, &t.SampleRate, &t.BitRate,
		&t.Channels, &t.BitsPerSample, &t.FileSize, &rawFileMtime, &rawFileCtime,
		&t.ScannedAt, &t.Lyrics,
	)
	if err != nil {
		return t, err
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
	file_size, file_mtime, file_ctime, scanned_at, lyrics`

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
func SearchTracks(query string) ([]model.Track, error) {
	pattern := "%" + query + "%"
	rows, err := pool.Query(
		`SELECT `+trackColumns+` FROM tracks
		 WHERE title LIKE ? ESCAPE '\' OR artists LIKE ? ESCAPE '\' OR album LIKE ? ESCAPE '\'`,
		pattern, pattern, pattern,
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
		SELECT DISTINCT `+trackColumns+` FROM tracks t, json_each(t.artists) a
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
