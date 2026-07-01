#pragma once

/// SPlayer 刮削器 —— 曲目元数据读取客户端（header-only）
///
/// 通过 HTTP 从 TS 层读取 library.db 曲目信息：
///   - GET /api/db/tracks/:id  获取曲目元数据（供队列模式使用）
///
/// 队列操作已改为直写 scraper-state.db（ScraperDb），不再走 HTTP。
/// 刮削结果写入音频文件标签后由 C# Scanner 接管入库，也无需 HTTP。

#include "scraper.h"
#include <curl/curl.h>
#include <nlohmann/json.hpp>
#include <stdexcept>

namespace splayer::scraper {

using json = nlohmann::json;

inline size_t dbWriteCb(char* ptr, size_t size, size_t nmemb, void* userdata) {
    auto* buf = static_cast<std::string*>(userdata);
    buf->append(ptr, size * nmemb);
    return size * nmemb;
}

class DbClient {
public:
    DbClient(const std::string& apiUrl, const std::string& proxyKey)
        : apiUrl_(apiUrl), proxyKey_(proxyKey)
    {
        curl_ = curl_easy_init();
        if (!curl_) throw std::runtime_error("curl_easy_init 失败");
        headers_ = curl_slist_append(headers_, ("x-proxy-key: " + proxyKey_).c_str());
        headers_ = curl_slist_append(headers_, "Content-Type: application/json");
    }

    ~DbClient() {
        if (headers_) curl_slist_free_all(headers_);
        if (curl_) curl_easy_cleanup(curl_);
    }

    DbClient(const DbClient&) = delete;
    DbClient& operator=(const DbClient&) = delete;

    /// 获取曲目元数据
    std::optional<TrackInfo> getTrack(const std::string& trackId) {
        std::string url = apiUrl_ + "/api/db/tracks/" + trackId;
        std::string body;
        if (!httpGet(url, body)) return std::nullopt;

        try {
            auto j = json::parse(body);
            TrackInfo t;
            t.id = j.value("id", "");
            t.title = j.value("title", "");
            t.artist = j.value("artist", "");
            t.album = j.value("album", "");
            t.albumArtist = j.value("album_artist", "");
            t.composer = j.value("composer", "");
            t.trackNumber = j.value("track", 0);
            t.discNumber = j.value("disc", 0);
            t.durationMs = j.value("duration", 0);
            t.filePath = j.value("path", "");
            t.mbid = j.value("mbid", "");
            t.albumMbid = j.value("album_mbid", "");
            t.artistMbid = j.value("artist_mbid", "");
            t.isrc = j.value("isrc", "");
            return t;
        } catch (const json::exception& e) {
            lastError_ = std::string("曲目解析失败: ") + e.what();
            return std::nullopt;
        }
    }

    const std::string& lastError() const { return lastError_; }

private:
    bool httpGet(const std::string& url, std::string& body) {
        body.clear();
        curl_easy_reset(curl_);
        curl_easy_setopt(curl_, CURLOPT_URL, url.c_str());
        curl_easy_setopt(curl_, CURLOPT_WRITEFUNCTION, dbWriteCb);
        curl_easy_setopt(curl_, CURLOPT_WRITEDATA, &body);
        curl_easy_setopt(curl_, CURLOPT_HTTPHEADER, headers_);
        curl_easy_setopt(curl_, CURLOPT_TIMEOUT_MS, 10000L);
        CURLcode res = curl_easy_perform(curl_);
        if (res != CURLE_OK) {
            lastError_ = std::string("GET 失败: ") + curl_easy_strerror(res);
            return false;
        }
        return true;
    }

    CURL* curl_ = nullptr;
    curl_slist* headers_ = nullptr;
    std::string apiUrl_;
    std::string proxyKey_;
    std::string lastError_;
};

} // namespace splayer::scraper
