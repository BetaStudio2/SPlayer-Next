package main

import (
	"context"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/splayer/subsonic-go/db"
	"github.com/splayer/subsonic-go/endpoints"
	"github.com/splayer/subsonic-go/middleware"
	"github.com/splayer/subsonic-go/xmlutil"
)

func main() {
	dbPath := os.Getenv("SPLAYER_DB_PATH")
	if dbPath == "" {
		dbPath = db.DefaultDBPath()
	}

	if err := db.Open(dbPath); err != nil {
		log.Fatalf("[subsonic-go] 打开数据库失败 %s: %v", dbPath, err)
	}
	defer db.Close()
	log.Printf("[subsonic-go] 数据库已连接: %s", dbPath)

	// 启动时去重：移除 path 重复的残余行（源于 C# 扫描器与 Node.js watcher 并发写入）
	dedupCount, err := db.RemoveDuplicatePaths()
	if err != nil {
		log.Printf("[subsonic-go] 路径去重失败: %v", err)
	} else if dedupCount > 0 {
		log.Printf("[subsonic-go] 路径去重: 清理 %d 条重复行", dedupCount)
	}

	r := chi.NewRouter()

	// 鉴权中间件（全部 /rest/* 端点）
	r.Use(middleware.Authenticate)

	// 端点分发：所有 /rest/* 请求统一进入 handler
	r.Handle("/*", http.HandlerFunc(dispatch))

	port := os.Getenv("SUBSONIC_PORT")
	if port == "" {
		port = "8081"
	}
	addr := ":" + port

	srv := &http.Server{Addr: addr, Handler: r}

	// SIGTERM 优雅退出（TS 进程管理器发 SIGTERM 时平滑关闭）
	go func() {
		sig := make(chan os.Signal, 1)
		signal.Notify(sig, syscall.SIGTERM, syscall.SIGINT)
		<-sig
		log.Printf("[subsonic-go] 收到退出信号，正在关闭...")
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if err := srv.Shutdown(ctx); err != nil {
			log.Printf("[subsonic-go] 关闭异常: %v", err)
		}
	}()

	log.Printf("[subsonic-go] Subsonic API 监听 %s", addr)
	if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		log.Fatalf("[subsonic-go] 服务启动失败: %v", err)
	}
	log.Printf("[subsonic-go] 已安全退出")
}

// dispatch 统一端点分发（与 TS 版 switch 逻辑一致）
func dispatch(w http.ResponseWriter, r *http.Request) {
	endpoint := middleware.ParseEndpoint(r.URL.Path)

	// 去掉 /rest 前缀后的端点名
	// 例如 /rest/ping.view → ping, /rest/rest/getCoverArt → getcoverart
	ep := strings.ToLower(endpoint)

	switch ep {
	/* ---- 基础 ---- */
	case "ping":
		endpoints.Ping(w, r)
	case "getlicense":
		endpoints.GetLicense(w, r)
	case "getopensubsonicextensions":
		endpoints.GetOpenSubsonicExtensions(w, r)
	case "getmusicfolders":
		endpoints.GetMusicFolders(w, r)

	/* ---- 浏览 ---- */
	case "getindexes":
		endpoints.GetIndexes(w, r)
	case "getartists":
		endpoints.GetArtists(w, r)
	case "getartist":
		endpoints.GetArtist(w, r)
	case "getalbum":
		endpoints.GetAlbum(w, r)
	case "getalbumlist", "getalbumlist2":
		endpoints.GetAlbumList(w, r, ep)
	case "getsong":
		endpoints.GetSong(w, r)
	case "getrandomsongs":
		endpoints.GetRandomSongs(w, r)

	/* ---- 媒体 ---- */
	case "getcoverart":
		endpoints.ServeCoverArt(w, r)
	case "stream", "download":
		endpoints.ServeStream(w, r, ep == "download")

	/* ---- 搜索 ---- */
	case "search2", "search3":
		endpoints.Search(w, r, ep)

	/* ---- 收藏 ---- */
	case "star":
		endpoints.Star(w, r)
	case "unstar":
		endpoints.Unstar(w, r)
	case "getstarred", "getstarred2":
		endpoints.GetStarred(w, r, ep)

	/* ---- 歌词 ---- */
	case "getlyrics":
		endpoints.GetLyrics(w, r)
	case "getlyricsbysongid":
		endpoints.GetLyricsBySongId(w, r)

	/* ---- 播放列表 ---- */
	case "getplaylists":
		endpoints.GetPlaylists(w, r)
	case "getplaylist":
		endpoints.GetPlaylist(w, r)

	/* ---- 分享 ---- */
	case "getshares":
		endpoints.GetShares(w, r)

	/* ---- 用户 ---- */
	case "getusers":
		endpoints.GetUsers(w, r)
	case "getuser":
		endpoints.GetUser(w, r)

	/* ---- 其他（简化实现） ---- */
	case "getgenres":
		endpoints.GetGenres(w, r)
	case "getnowplaying":
		endpoints.GetNowPlaying(w, r)
	case "gettopsongs":
		endpoints.GetTopSongs(w, r)
	case "getsimilarartists", "getsimilarartists2":
		endpoints.GetSimilarArtists(w, r, ep)
	case "getsongsbygenre":
		endpoints.GetSongsByGenre(w, r)
	case "scrobble":
		endpoints.Scrobble(w, r)

	default:
		log.Printf("[subsonic-go] 未实现的端点: %s", ep)
		xmlutil.Send(w, r, map[string]any{}, &xmlutil.SubError{
			Code:    0,
			Message: "Endpoint " + ep + " not implemented",
		})
	}
}
