package endpoints

import (
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/splayer/subsonic-go/db"
	"github.com/splayer/subsonic-go/model"
	"github.com/splayer/subsonic-go/util"
	"github.com/splayer/subsonic-go/xmlutil"
)

// ServeStream /rest/stream.view + /rest/download.view
func ServeStream(w http.ResponseWriter, r *http.Request, asDownload bool) {
	id := r.URL.Query().Get("id")
	track, err := db.GetTrackByID(id)
	if err != nil || track == nil {
		xmlutil.Send(w, r, map[string]any{}, &xmlutil.SubError{Code: 70, Message: "Song not found"})
		return
	}

	info, err := os.Stat(track.Path)
	if err != nil {
		xmlutil.Send(w, r, map[string]any{}, &xmlutil.SubError{Code: 70, Message: "File not found"})
		return
	}

	mime := util.MimeOf(track.Path)

	// 无 Range 请求或下载模式 → 全量发送
	rangeHeader := r.Header.Get("Range")
	if rangeHeader == "" || asDownload {
		f, err := os.Open(track.Path)
		if err != nil {
			http.Error(w, "internal error", 500)
			return
		}
		defer f.Close()

		w.Header().Set("Content-Type", mime)
		w.Header().Set("Accept-Ranges", "bytes")
		w.Header().Set("Cache-Control", "public, max-age=3600")
		if asDownload {
			w.Header().Set("Content-Disposition", fmt.Sprintf(`attachment; filename="%s"`, filepath.Base(track.Path)))
		}
		http.ServeContent(w, r, filepath.Base(track.Path), info.ModTime(), f)
		return
	}

	// Range 请求
	f, err := os.Open(track.Path)
	if err != nil {
		http.Error(w, "internal error", 500)
		return
	}
	defer f.Close()
	w.Header().Set("Content-Type", mime)
	w.Header().Set("Accept-Ranges", "bytes")
	w.Header().Set("Cache-Control", "public, max-age=3600")
	http.ServeContent(w, r, filepath.Base(track.Path), info.ModTime(), f)
}

// ServeCoverArt /rest/getCoverArt.view
func ServeCoverArt(w http.ResponseWriter, r *http.Request) {
	id := r.URL.Query().Get("id")
	sizeStr := r.URL.Query().Get("size")
	size := 0
	if sizeStr != "" {
		size, _ = strconv.Atoi(sizeStr)
	}

	coverPath := filepath.Join(db.CoverCacheDir(), id+".img")

	// 若不是 track，找对应 album/artist 下第一个有封面的 track
	if _, err := os.Stat(coverPath); os.IsNotExist(err) {
		var track *model.Track
		// 尝试按 album id 查
		if name := findAlbumNameByID(id); name != "" {
			tracks, _ := db.GetAlbumTracks(name)
			for _, t := range tracks {
				if t.Cover.Valid && t.Cover.String != "" {
					track = &t
					break
				}
			}
		}
		if track == nil {
			if name := findArtistNameByID(id); name != "" {
				tracks, _ := db.GetArtistTracks(name)
				for _, t := range tracks {
					if t.Cover.Valid && t.Cover.String != "" {
						track = &t
						break
					}
				}
			}
		}
		if track != nil {
			coverPath = filepath.Join(db.CoverCacheDir(), track.ID+".img")
		}
	}

	if _, err := os.Stat(coverPath); err != nil {
		http.Error(w, "cover not found", 404)
		return
	}

	// size > 0 时需要缩放（Go 端简化：直接返回原图，缩放交给客户端或后续接入 imaging 库）
	// 生产环境可引入 github.com/disintegration/imaging 做缩放
	_ = size
	f, err := os.Open(coverPath)
	if err != nil {
		http.Error(w, "cover error", 500)
		return
	}
	defer f.Close()

	// 探测图片类型
	ext := strings.ToLower(filepath.Ext(coverPath))
	mime := "image/jpeg"
	switch ext {
	case ".png":
		mime = "image/png"
	case ".webp":
		mime = "image/webp"
	case ".gif":
		mime = "image/gif"
	}
	w.Header().Set("Content-Type", mime)
	w.Header().Set("Cache-Control", "public, max-age=86400")
	stat, _ := f.Stat()
	http.ServeContent(w, r, stat.Name(), stat.ModTime(), f)
}
