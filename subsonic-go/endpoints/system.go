package endpoints

import (
	"net/http"

	"github.com/splayer/subsonic-go/xmlutil"
)

// Ping /rest/ping.view
func Ping(w http.ResponseWriter, r *http.Request) {
	xmlutil.Send(w, r, map[string]any{}, nil)
}

// GetLicense /rest/getLicense.view
func GetLicense(w http.ResponseWriter, r *http.Request) {
	xmlutil.Send(w, r, map[string]any{
		"license": map[string]any{
			"valid":          true,
			"email":          "splayer@local",
			"licenseExpires": "2099-01-01",
		},
	}, nil)
}

// GetOpenSubsonicExtensions /rest/getOpenSubsonicExtensions.view
func GetOpenSubsonicExtensions(w http.ResponseWriter, r *http.Request) {
	xmlutil.Send(w, r, map[string]any{
		"openSubsonicExtensions": []any{
			map[string]any{"name": "formPost", "versions": []any{1}},
			map[string]any{"name": "songLyrics", "versions": []any{1, 2}},
		},
	}, nil)
}

// GetMusicFolders /rest/getMusicFolders.view
func GetMusicFolders(w http.ResponseWriter, r *http.Request) {
	xmlutil.Send(w, r, map[string]any{
		"musicFolders": map[string]any{
			"musicFolder": []any{
				map[string]any{"id": 0, "name": "Music"},
			},
		},
	}, nil)
}

// GetGenres /rest/getGenres.view（简化：返回空）
func GetGenres(w http.ResponseWriter, r *http.Request) {
	xmlutil.Send(w, r, map[string]any{
		"genres": map[string]any{"genre": []any{}},
	}, nil)
}

// GetNowPlaying /rest/getNowPlaying.view
func GetNowPlaying(w http.ResponseWriter, r *http.Request) {
	xmlutil.Send(w, r, map[string]any{"nowPlaying": map[string]any{}}, nil)
}

// GetTopSongs /rest/getTopSongs.view
func GetTopSongs(w http.ResponseWriter, r *http.Request) {
	xmlutil.Send(w, r, map[string]any{"topSongs": map[string]any{"song": []any{}}}, nil)
}

// GetSimilarArtists /rest/getSimilarArtists.view + getSimilarArtists2
func GetSimilarArtists(w http.ResponseWriter, r *http.Request, endpoint string) {
	key := "similarArtists"
	if endpoint == "getsimilarartists2" {
		key = "similarArtists2"
	}
	xmlutil.Send(w, r, map[string]any{
		key: map[string]any{"artist": []any{}},
	}, nil)
}

// GetSongsByGenre /rest/getSongsByGenre.view
func GetSongsByGenre(w http.ResponseWriter, r *http.Request) {
	xmlutil.Send(w, r, map[string]any{"songsByGenre": map[string]any{"song": []any{}}}, nil)
}

// Scrobble /rest/scrobble.view（简化：仅日志）
func Scrobble(w http.ResponseWriter, r *http.Request) {
	xmlutil.Send(w, r, map[string]any{}, nil)
}
