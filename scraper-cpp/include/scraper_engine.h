#pragma once

/// SPlayer 刮削器 —— 刮削引擎核心（header-only）
///
/// 两种工作模式：
/// 1. 目录扫描模式（推荐）：scrapeDirs 非空时，直接扫描目录中的音频文件，
///    使用 TagLib 读取现有标签作为查询基础，不依赖 DB tracks 表。
///    适用于刮削目录不在扫描路径中的场景。
/// 2. DB 队列模式（兼容）：scrapeDirs 为空时，从 DB scrape_queue 获取任务。
///    适用于已扫描入库的曲目需要重新刮削的场景。

#include "scraper.h"
#include "api_client.h"
#include "db_client.h"
#include "scraper_db.h"
#include "tag_writer.h"
#include "file_scanner.h"
#include <iostream>
#include <thread>
#include <chrono>
#include <atomic>
#include <cstdlib>
#include <memory>

namespace splayer::scraper {

/// 全局取消标志（由信号处理器设置）
inline std::atomic<bool>& cancelFlag() {
    static std::atomic<bool> flag{false};
    return flag;
}

// AsyncResultSubmitter 已移除。
// 刮削器只写音频文件标签（不写 SQLite），元数据由下次扫描重新读取入库。

class ScraperEngine {
public:
    ScraperEngine(const ScraperConfig& cfg)
        : cfg_(cfg), db_(cfg.apiUrl, cfg.proxyKey), resolver_(cfg),
          tagWriter_(), fileScanner_(cfg)
    {
        // 初始化 scraper-state.db 直写（必须成功——队列操作不再走 HTTP 回退）
        const char* scraperDbPath = std::getenv("SPLAYER_SCRAPER_DB_PATH");
        if (!scraperDbPath || !scraperDbPath[0]) {
            throw std::runtime_error("SPLAYER_SCRAPER_DB_PATH 未设置，无法创建直写队列");
        }
        scraperDb_.reset(new ScraperDb(scraperDbPath));
        std::cerr << "[scraper] 队列直写模式: " << scraperDbPath << std::endl;

        std::cerr << "[scraper] 初始化完成" << std::endl;
        std::cerr << "[scraper] API: " << cfg.apiUrl << std::endl;
        std::cerr << "[scraper] 批量大小: " << cfg.batchSize << std::endl;
        std::cerr << "[scraper] 最大重试: " << cfg.maxRetries << std::endl;
        std::cerr << "[scraper] 嵌入元数据: " << (cfg.embedMetadata ? "是" : "否") << std::endl;
        std::cerr << "[scraper] 嵌入封面: " << (cfg.embedCover ? "是" : "否") << std::endl;
        std::cerr << "[scraper] 嵌入歌词: " << (cfg.embedLyrics ? "是" : "否") << std::endl;
        std::cerr << "[scraper] 数据源: MusicBrainz=" << (cfg.useMusicBrainz ? "是" : "否")
                  << ", Deezer=" << (cfg.useDeezer ? "是" : "否")
                  << ", iTunes=" << (cfg.useItunes ? "是" : "否")
                  << ", Netease=" << (cfg.useNetease ? "是" : "否")
                  << ", QQMusic=" << (cfg.useQQMusic ? "是" : "否")
                  << ", Kugou=" << (cfg.useKugou ? "是" : "否")
                  << ", Kuwo=" << (cfg.useKuwo ? "是" : "否")
                  << ", Migu=" << (cfg.useMigu ? "是" : "否") << std::endl;
        if (!cfg.scrapeDirs.empty()) {
            std::cerr << "[scraper] 工作模式: 目录扫描" << std::endl;
            for (const auto& d : cfg.scrapeDirs) {
                std::cerr << "[scraper]   刮削目录: " << d << std::endl;
            }
        } else {
            std::cerr << "[scraper] 工作模式: DB 队列" << std::endl;
        }
    }

    /// 运行一轮刮削
    int runOnce() {
        // 根据配置选择工作模式
        if (!cfg_.scrapeDirs.empty()) {
            return runOnceFromDirs();
        }
        return runOnceFromQueue();
    }

    /// 目录扫描模式：直接扫描 scrapeDirs
    int runOnceFromDirs() {
        // 1. 扫描目录，读取所有音频文件标签
        auto tracks = fileScanner_.scanDirs(cfg_.scrapeDirs);
        int total = static_cast<int>(tracks.size());
        
        if (tracks.empty()) {
            std::cerr << "[scraper] 目录中无音频文件" << std::endl;
            return 0;
        }

        std::cerr << "[scraper] 取到 " << total << " 个待处理文件" << std::endl;
        int success = 0;
        int failed = 0;
        int skipped = 0;

        for (int i = 0; i < total; ++i) {
            if (cancelFlag().load(std::memory_order_relaxed)) {
                std::cerr << "[scraper] 收到取消信号，已处理 " << i << "/" << total
                          << "，安全退出" << std::endl;
                break;
            }

            const auto& track = tracks[i];

            // 输出进度（TS 层解析 stderr 中的进度信息）
            std::cerr << "[scraper] [" << (i + 1) << "/" << total << "] "
                      << track.artist << " - " << track.title
                      << " (" << track.album << ")" << std::endl;

            // 跳过已刮削的文件（如果启用）
            if (cfg_.skipScraped && isLikelyScraped(track)) {
                std::cerr << "[scraper]   ⚠ 跳过（已有完整元数据）" << std::endl;
                skipped++;
                scraperDb_->updateQueueStatus(track.filePath, "skipped");
                std::cerr << "[scraper] [done " << (i + 1) << "/" << total << "] status=skipped" << std::endl;
                continue;
            }

            // 2. 多源解析（MusicBrainz → Deezer → iTunes，含封面/歌词）
            auto result = resolver_.resolve(track);

            bool haveIdentifier = result.mbid.has_value() || result.isrc.has_value();
            bool haveMetadata = result.title.has_value() && result.artist.has_value();
            if (!haveIdentifier && !haveMetadata) {
                std::cerr << "[scraper]   - 未找到匹配" << std::endl;
                failed++;
                scraperDb_->updateQueueStatus(track.filePath, "not_found");
                std::cerr << "[scraper] [done " << (i + 1) << "/" << total << "] status=not_found" << std::endl;
                continue;
            }

            // 输出数据源与封面/歌词状态
            if (cfg_.embedCover && !result.coverData.empty()) {
                std::cerr << "[scraper]   ✓ 封面: " << result.coverData.size() << " bytes" << std::endl;
            }
            if (cfg_.embedLyrics && result.lyrics) {
                std::cerr << "[scraper]   ✓ 歌词" << std::endl;
            }

            // 5. 写入音频文件标签（立即写入——本地文件 I/O，开销低）
            bool tagWritten = true; // 无嵌入需求时视为成功
            if (cfg_.embedMetadata || cfg_.embedCover || cfg_.embedLyrics) {
                if (!track.filePath.empty()) {
                    if (tagWriter_.writeToFile(track.filePath, result, cfg_)) {
                        std::cerr << "[scraper]   ✓ 标签写入成功" << std::endl;
                    } else {
                        std::cerr << "[scraper]   ✗ 标签写入失败: " << tagWriter_.lastError() << std::endl;
                        tagWritten = false;
                    }
                } else {
                    std::cerr << "[scraper]   ⚠ 无文件路径，跳过标签写入" << std::endl;
                }
            }

            if (!tagWritten) {
                failed++;
                scraperDb_->updateQueueStatus(track.filePath, "failed");
                std::cerr << "[scraper] [done " << (i + 1) << "/" << total << "] status=failed" << std::endl;
                continue;
            }

            // 元数据已写入音频文件，不再写 SQLite
            // 下次扫描时会从文件重新读取入库
            success++;
            scraperDb_->updateQueueStatus(track.filePath, "success");

            // 输出精确进度标记（TS 层据此更新进度）
            std::cerr << "[scraper] [done " << (i + 1) << "/" << total << "] status=success" << std::endl;
        }

        std::cerr << "[scraper] 本轮完成: " << success << " 成功, "
                  << failed << " 失败, " << skipped << " 跳过" << std::endl;
        return success;
    }

    /// DB 队列模式（兼容旧流程）
    int runOnceFromQueue() {
        // 启动时重置卡住的任务（上次崩溃遗留的 running 状态）
        int reset = scraperDb_->resetStuck(120); // 120min timeout
        if (reset > 0) {
            std::cerr << "[scraper] 重置 " << reset << " 个卡住的任务" << std::endl;
        }

        auto queue = scraperDb_->claimQueue(cfg_.batchSize);
        int total = static_cast<int>(queue.size());
        
        if (queue.empty()) {
            std::cerr << "[scraper] 队列为空，无需处理" << std::endl;
            return 0;
        }

        std::cerr << "[scraper] 取到 " << total << " 个待刮削项" << std::endl;
        int success = 0;
        int failed = 0;
        // 记录取消时的位置，用于释放未处理任务
        int canceledAt = -1;

        for (int i = 0; i < total; ++i) {
            // 优雅退出检查
            if (cancelFlag().load(std::memory_order_relaxed)) {
                canceledAt = i;
                std::cerr << "[scraper] 收到取消信号，已处理 " << i << "/" << total
                          << "，安全退出" << std::endl;
                break;
            }

            const auto& item = queue[i];

            // 输出进度
            std::cerr << "[scraper] [" << (i + 1) << "/" << total << "] "
                      << "trackId=" << item.trackId << std::endl;

            if (item.retries >= cfg_.maxRetries) {
                std::cerr << "[scraper] 跳过 " << item.trackId
                          << "（重试次数已达上限）" << std::endl;
                updateStatus(item.trackId, "skipped", "max retries exceeded");
                std::cerr << "[scraper] [done " << (i + 1) << "/" << total << "] status=skipped" << std::endl;
                continue;
            }

            auto track = db_.getTrack(item.trackId);
            if (!track) {
                std::cerr << "[scraper] 获取曲目失败: " << item.trackId << std::endl;
                updateStatus(item.trackId, "failed", db_.lastError());
                failed++;
                std::cerr << "[scraper] [done " << (i + 1) << "/" << total << "] status=failed" << std::endl;
                continue;
            }

            std::cerr << "[scraper] 刮削: " << track->artist << " - "
                      << track->title << " (" << track->album << ")" << std::endl;

            // 跳过已刮削的文件（如果启用）
            if (cfg_.skipScraped && isLikelyScraped(*track)) {
                std::cerr << "[scraper]   ⚠ 跳过（已有完整元数据）" << std::endl;
                updateStatus(item.trackId, "skipped", "already scraped");
                std::cerr << "[scraper] [done " << (i + 1) << "/" << total << "] status=skipped" << std::endl;
                continue;
            }

            // 1. 多源解析（MusicBrainz → Deezer → iTunes，含封面/歌词）
            auto result = resolver_.resolve(*track);

            bool haveIdentifier = result.mbid.has_value() || result.isrc.has_value();
            bool haveMetadata = result.title.has_value() && result.artist.has_value();
            if (!haveIdentifier && !haveMetadata) {
                updateStatus(item.trackId, "not_found", "no source matched");
                failed++;
                std::cerr << "[scraper]   - 未找到匹配" << std::endl;
                std::cerr << "[scraper] [done " << (i + 1) << "/" << total << "] status=not_found" << std::endl;
                continue;
            }

            // 输出数据源与封面/歌词状态
            if (cfg_.embedCover && !result.coverData.empty()) {
                std::cerr << "[scraper]   ✓ 封面: " << result.coverData.size() << " bytes" << std::endl;
            }
            if (cfg_.embedLyrics && result.lyrics) {
                std::cerr << "[scraper]   ✓ 歌词" << std::endl;
            }

            // 4. 写入音频文件标签
            bool tagWritten = true; // 无嵌入需求时视为成功
            if (cfg_.embedMetadata || cfg_.embedCover || cfg_.embedLyrics) {
                if (!track->filePath.empty()) {
                    if (tagWriter_.writeToFile(track->filePath, result, cfg_)) {
                        std::cerr << "[scraper]   ✓ 标签写入成功" << std::endl;
                    } else {
                        std::cerr << "[scraper]   ✗ 标签写入失败: " << tagWriter_.lastError() << std::endl;
                        tagWritten = false;
                    }
                } else {
                    std::cerr << "[scraper]   ⚠ 无文件路径，跳过标签写入" << std::endl;
                }
            }

            if (!tagWritten) {
                updateStatus(item.trackId, "failed", tagWriter_.lastError());
                failed++;
            } else {
                updateStatus(item.trackId, "done");
                success++;
            }

            // 输出精确进度标记（TS 层据此更新进度）
            std::cerr << "[scraper] [done " << (i + 1) << "/" << total << "] status=success" << std::endl;
        }

        // 取消时释放未处理的任务（将 running → pending，不递增 retries）
        if (canceledAt >= 0) {
            std::vector<std::string> unprocessed;
            for (int j = canceledAt; j < total; ++j) {
                unprocessed.push_back(queue[j].trackId);
            }
            if (!unprocessed.empty()) {
                std::cerr << "[scraper] 取消中，释放 " << unprocessed.size() << " 个未处理任务" << std::endl;
                scraperDb_->releaseItems(unprocessed);
            }
        }

        if (failed > 0) {
            std::cerr << "[scraper] 本轮完成: " << success << " 成功, "
                      << failed << " 失败" << std::endl;
        }

        return success;
    }

    /// 持续运行模式
    void runDaemon(int intervalSec = 60) {
        std::cerr << "[scraper] 守护模式启动，间隔 " << intervalSec << " 秒" << std::endl;
        while (!cancelFlag().load(std::memory_order_relaxed)) {
            try {
                runOnce();
            } catch (const std::exception& e) {
                std::cerr << "[scraper] 异常: " << e.what() << std::endl;
            }
            // 可中断的等待：每秒检查一次取消标志
            for (int s = 0; s < intervalSec && !cancelFlag().load(std::memory_order_relaxed); ++s) {
                std::this_thread::sleep_for(std::chrono::seconds(1));
            }
        }

        // 收到取消信号后：确保所有异步结果写入完毕
        shutdown();
        std::cerr << "[scraper] 守护模式安全退出" << std::endl;
    }

    /// 显式清理：等待异步提交全部完成，释放所有待处理资源
    /// 析构函数会自动调用，但在长生命周期中提前调用可提前释放内存
    void shutdown() {
        // 无后台写入，无需等待
    }

private:
    /// 判断文件是否已刮削
    /// 判断依据（按可靠性排序）：
    ///   1. 有 MusicBrainz MBID（recording/album/artist 任一）→ 已刮削
    ///   2. 有 ISRC → 已刮削
    ///
    /// 不再仅靠 title/artist/album/trackNumber 判断，因为：
    /// - 很多合法音乐没有完整发行元数据（单曲、现场录音、独立音乐）
    /// - 元数据可能损坏但被判定为完整（标题为"Track 01"等垃圾值）
    /// - 用户手动填写的元数据不应被误判为已刮削
    ///
    /// MBID 和 ISRC 是刮削器写入的可靠标志，只有真正刮削过的文件才会有。
    /// 用户可以通过 skipScraped=false 或 --force 禁用跳过行为。
    bool isLikelyScraped(const TrackInfo& track) {
        // 委托给 FileScanner 的判断方法（基于 MBID/ISRC）
        return fileScanner_.isAlreadyScraped(track);
    }

    /// 队列状态更新（直写 scraper-state.db）
    void updateStatus(const std::string& trackId, const std::string& status,
                      const std::string& error = "") {
        scraperDb_->updateQueueStatus(trackId, status, error);
    }

    ScraperConfig cfg_;
    DbClient db_;
    std::unique_ptr<ScraperDb> scraperDb_;
    MetadataResolver resolver_;
    TagWriter tagWriter_;
    FileScanner fileScanner_;
};

} // namespace splayer::scraper
