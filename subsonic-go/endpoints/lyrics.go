package endpoints

import (
	"net/http"
	"strings"

	"github.com/splayer/subsonic-go/db"
	"github.com/splayer/subsonic-go/lyric"
	"github.com/splayer/subsonic-go/util"
	"github.com/splayer/subsonic-go/xmlutil"
)

// GetLyrics /rest/getLyrics.view
func GetLyrics(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()

	// 优先按 id 查 track
	var trackID string
	var artistStr, titleStr string

	if q.Get("id") != "" {
		track, err := db.GetTrackByID(q.Get("id"))
		if err == nil && track != nil {
			trackID = track.ID
			artists := util.ParseArtists(track.ArtistsJSON)
			artistStr = util.FirstArtist(artists)
			titleStr = track.Title
		}
	}

	// 无 id 时用 artist + title 参数
	if trackID == "" {
		artistStr = q.Get("artist")
		titleStr = q.Get("title")
	}

	if trackID == "" && artistStr == "" && titleStr == "" {
		xmlutil.Send(w, r, map[string]any{}, &xmlutil.SubError{Code: 10, Message: "Missing id or artist/title"})
		return
	}

	// 取歌词（仅内嵌，在线匹配后续接入 TS API）
	var mainLyric string
	if trackID != "" {
		if embedded, err := db.GetTrackLyrics(trackID); err == nil && strings.TrimSpace(embedded) != "" {
			mainLyric = embedded
		}
	}

	if mainLyric == "" {
		xmlutil.Send(w, r, map[string]any{"lyrics": map[string]any{}}, nil)
		return
	}

	prepared := lyric.Prepare(lyric.TrackLyricPayload{Main: mainLyric})

	xmlutil.Send(w, r, map[string]any{
		"lyrics": map[string]any{
			"artist": artistStr,
			"title":  titleStr,
			"synced":  boolStr(prepared.Synced),
			"value":   prepared.ClassicText,
		},
	}, nil)
}

// GetLyricsBySongId /rest/getLyricsBySongId.view
func GetLyricsBySongId(w http.ResponseWriter, r *http.Request) {
	id := r.URL.Query().Get("id")
	if id == "" {
		xmlutil.Send(w, r, map[string]any{}, &xmlutil.SubError{Code: 10, Message: "Missing id"})
		return
	}

	track, err := db.GetTrackByID(id)
	if err != nil || track == nil {
		xmlutil.Send(w, r, map[string]any{}, &xmlutil.SubError{Code: 70, Message: "Song not found"})
		return
	}

	embedded, err := db.GetTrackLyrics(id)
	if err != nil || strings.TrimSpace(embedded) == "" {
		xmlutil.Send(w, r, map[string]any{"lyricsList": map[string]any{}}, nil)
		return
	}

	prepared := lyric.Prepare(lyric.TrackLyricPayload{Main: embedded})
	if len(prepared.StructuredLines) == 0 {
		xmlutil.Send(w, r, map[string]any{"lyricsList": map[string]any{}}, nil)
		return
	}

	artists := util.ParseArtists(track.ArtistsJSON)
	lines := make([]any, 0, len(prepared.StructuredLines))
	for _, l := range prepared.StructuredLines {
		lines = append(lines, map[string]any{"start": l.Start, "value": l.Value})
	}

	xmlutil.Send(w, r, map[string]any{
		"lyricsList": map[string]any{
			"structuredLyrics": []any{
				map[string]any{
					"lang":           "und",
					"displayArtist":  util.FirstArtist(artists),
					"displayTitle":   track.Title,
					"synced":          boolStr(prepared.Synced),
					"offset":         0,
					"line":           lines,
				},
			},
		},
	}, nil)
}

func boolStr(b bool) string {
	if b {
		return "true"
	}
	return "false"
}
