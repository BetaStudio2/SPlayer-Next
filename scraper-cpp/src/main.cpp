/// SPlayer 刮削器 —— 命令行入口
///
/// 用法：
///   splayer-scraper once [--dirs /path1,/path2]   处理一轮
///   splayer-scraper daemon [--interval N] [--dirs /path1,/path2]  持续运行
///   splayer-scraper query <artist> <title>        查询单首（调试）
///
/// 环境变量：
///   SPLAYER_API_URL     TS 层 API 地址（默认 http://localhost:8080）
///   PROXY_KEY           SQLite 写入代理密钥
///   SCRAPER_DIRS        刮削目录列表（逗号分隔），优先级低于 --dirs
///   SCRAPER_BATCH_SIZE  每批处理数量（默认 10）
///   SCRAPER_EMBED_METADATA  是否嵌入元数据（0=关闭，默认开启）
///   SCRAPER_EMBED_COVER     是否嵌入封面（0=关闭，默认开启）
///   SCRAPER_EMBED_LYRICS    是否嵌入歌词（0=关闭，默认开启）
///   SCRAPER_SKIP_SCRAPED    是否跳过已刮削文件（0=关闭，默认开启）
///   SCRAPER_USE_MUSICBRAINZ 是否使用 MusicBrainz（0=关闭，默认开启）
///   SCRAPER_USE_DEEZER      是否使用 Deezer（0=关闭，默认开启）
///   SCRAPER_USE_ITUNES      是否使用 iTunes Search（0=关闭，默认开启）
///   SCRAPER_USE_NETEASE     是否使用网易云（0=关闭，默认开启）
///   SCRAPER_USE_QQMUSIC     是否使用 QQ 音乐（0=关闭，默认开启）
///   SCRAPER_USE_KUGOU       是否使用酷狗（0=关闭，默认开启）
///   SCRAPER_USE_KUWO        是否使用酷我（0=关闭，默认开启）
///   SCRAPER_USE_MIGU        是否使用咪咕（0=关闭，默认开启）
///   SCRAPER_CONCURRENT_WORKERS 并发查询线程数（默认 4）
///   SCRAPER_MAX_SCAN_FILES     单次扫描最大文件数（默认 50000）
///   SCRAPER_MAX_FILE_SIZE_MB   文件大小上限 MB（默认 500）
///   SCRAPER_MAX_SCAN_ERRORS    连续失败上限（默认 50）

#include "scraper_engine.h"
#include <iostream>
#include <string>
#include <vector>
#include <cstdlib>
#include <sstream>
#include <csignal>

using namespace splayer::scraper;

static void printUsage() {
    std::cerr << "SPlayer 元数据刮削器\n\n"
              << "用法:\n"
              << "  splayer-scraper once [--dirs /path1,/path2]   处理一轮\n"
              << "  splayer-scraper daemon [--interval N] [--dirs /path1,/path2]  持续运行\n"
              << "  splayer-scraper query <artist> <title>        查询单首（调试）\n\n"
              << "选项:\n"
              << "  --dirs <paths>    刮削目录列表（逗号分隔），独立于扫描目录\n"
              << "  --interval <sec>  守护模式间隔（默认 60 秒）\n\n"
              << "环境变量:\n"
              << "  SPLAYER_API_URL     TS 层 API 地址\n"
              << "  PROXY_KEY           SQLite 写入代理密钥\n"
              << "  SCRAPER_DIRS        刮削目录列表（逗号分隔）\n"
              << "  SCRAPER_BATCH_SIZE  每批处理数量\n"
              << "  SCRAPER_EMBED_METADATA  嵌入元数据开关（0=关闭）\n"
              << "  SCRAPER_EMBED_COVER     嵌入封面开关（0=关闭）\n"
              << "  SCRAPER_EMBED_LYRICS    嵌入歌词开关（0=关闭）\n"
              << "  SCRAPER_SKIP_SCRAPED    跳过已刮削文件开关（0=关闭）\n"
              << "  SCRAPER_USE_MUSICBRAINZ MusicBrainz 开关（0=关闭）\n"
              << "  SCRAPER_USE_DEEZER      Deezer 开关（0=关闭）\n"
              << "  SCRAPER_USE_ITUNES      iTunes Search 开关（0=关闭）\n"
              << "  SCRAPER_USE_NETEASE     网易云开关（0=关闭）\n"
              << "  SCRAPER_USE_QQMUSIC     QQ 音乐开关（0=关闭）\n"
              << "  SCRAPER_USE_KUGOU       酷狗开关（0=关闭）\n"
              << "  SCRAPER_USE_KUWO        酷我开关（0=关闭）\n"
              << "  SCRAPER_USE_MIGU        咪咕开关（0=关闭）\n"
              << "  SCRAPER_CONCURRENT_WORKERS 并发线程数（默认由设备硬件自动确定）\n"
              << "  SCRAPER_MAX_SCAN_FILES     单次扫描最大文件数（默认 50000）\n"
              << "  SCRAPER_MAX_FILE_SIZE_MB   文件大小上限 MB（默认 500）\n"
              << "  SCRAPER_MAX_SCAN_ERRORS    连续失败上限（默认 50）\n";
}

/// 解析逗号分隔的路径列表
static std::vector<std::string> parseDirs(const std::string& s) {
    std::vector<std::string> dirs;
    std::stringstream ss(s);
    std::string item;
    while (std::getline(ss, item, ',')) {
        // 去除前后空白
        auto start = item.find_first_not_of(" \t");
        if (start == std::string::npos) continue;
        auto end = item.find_last_not_of(" \t");
        dirs.push_back(item.substr(start, end - start + 1));
    }
    return dirs;
}

static ScraperConfig loadConfig(int argc, char* argv[]) {
    ScraperConfig cfg;

    // API 地址
    const char* apiUrl = std::getenv("SPLAYER_API_URL");
    cfg.apiUrl = apiUrl ? apiUrl : "http://localhost:8080";

    // 代理密钥
    const char* proxyKey = std::getenv("PROXY_KEY");
    cfg.proxyKey = proxyKey ? proxyKey : "dev-proxy-key";

    // 批量大小
    const char* batchSize = std::getenv("SCRAPER_BATCH_SIZE");
    if (batchSize) cfg.batchSize = std::atoi(batchSize);

    // 嵌入选项（默认全部启用）
    const char* embedMeta = std::getenv("SCRAPER_EMBED_METADATA");
    if (embedMeta && std::string(embedMeta) == "0") cfg.embedMetadata = false;

    const char* embedCover = std::getenv("SCRAPER_EMBED_COVER");
    if (embedCover && std::string(embedCover) == "0") cfg.embedCover = false;

    const char* embedLyrics = std::getenv("SCRAPER_EMBED_LYRICS");
    if (embedLyrics && std::string(embedLyrics) == "0") cfg.embedLyrics = false;

    // 跳过已刮削文件
    const char* skipScraped = std::getenv("SCRAPER_SKIP_SCRAPED");
    if (skipScraped && std::string(skipScraped) == "0") cfg.skipScraped = false;

    // 数据源开关
    const char* useMb = std::getenv("SCRAPER_USE_MUSICBRAINZ");
    if (useMb && std::string(useMb) == "0") cfg.useMusicBrainz = false;

    const char* useDz = std::getenv("SCRAPER_USE_DEEZER");
    if (useDz && std::string(useDz) == "0") cfg.useDeezer = false;

    const char* useIt = std::getenv("SCRAPER_USE_ITUNES");
    if (useIt && std::string(useIt) == "0") cfg.useItunes = false;

    // 中文音乐源开关
    const char* useNe = std::getenv("SCRAPER_USE_NETEASE");
    if (useNe && std::string(useNe) == "0") cfg.useNetease = false;

    const char* useQQ = std::getenv("SCRAPER_USE_QQMUSIC");
    if (useQQ && std::string(useQQ) == "0") cfg.useQQMusic = false;

    const char* useKg = std::getenv("SCRAPER_USE_KUGOU");
    if (useKg && std::string(useKg) == "0") cfg.useKugou = false;

    const char* useKw = std::getenv("SCRAPER_USE_KUWO");
    if (useKw && std::string(useKw) == "0") cfg.useKuwo = false;

    const char* useMg = std::getenv("SCRAPER_USE_MIGU");
    if (useMg && std::string(useMg) == "0") cfg.useMigu = false;

    // 并发线程数（默认由 detectParallelism 根据设备硬件自动决定）
    const char* workers = std::getenv("SCRAPER_CONCURRENT_WORKERS");
    if (workers) {
        try {
            int n = std::stoi(workers);
            if (n > 0 && n <= 32) cfg.concurrentWorkers = n;
        } catch (...) {}
    }

    // 安全限制：最大扫描文件数
    const char* maxFiles = std::getenv("SCRAPER_MAX_SCAN_FILES");
    if (maxFiles) {
        try {
            int n = std::stoi(maxFiles);
            if (n > 0 && n <= 500000) cfg.maxScanFiles = n;
        } catch (...) {}
    }

    // 安全限制：最大文件大小（MB）
    const char* maxSize = std::getenv("SCRAPER_MAX_FILE_SIZE_MB");
    if (maxSize) {
        try {
            int n = std::stoi(maxSize);
            if (n > 0 && n <= 10000) cfg.maxFileSizeMb = n;
        } catch (...) {}
    }

    // 安全限制：最大连续错误数
    const char* maxErrors = std::getenv("SCRAPER_MAX_SCAN_ERRORS");
    if (maxErrors) {
        try {
            int n = std::stoi(maxErrors);
            if (n > 0 && n <= 10000) cfg.maxScanErrors = n;
        } catch (...) {}
    }

    // 解析 --dirs 参数（优先级高于环境变量）
    for (int i = 1; i < argc; ++i) {
        std::string arg = argv[i];
        if (arg == "--dirs" && i + 1 < argc) {
            cfg.scrapeDirs = parseDirs(argv[++i]);
        }
    }

    // 如果命令行未指定，回退到环境变量
    if (cfg.scrapeDirs.empty()) {
        const char* envDirs = std::getenv("SCRAPER_DIRS");
        if (envDirs && *envDirs) {
            cfg.scrapeDirs = parseDirs(envDirs);
        }
    }

    return cfg;
}

int main(int argc, char* argv[]) {
    if (argc < 2) {
        printUsage();
        return 1;
    }

    // 注册信号处理器：SIGTERM/SIGINT 设置取消标志，刮削器在下一个文件边界安全退出
    struct sigaction sa{};
    sa.sa_handler = [](int) { cancelFlag().store(true, std::memory_order_relaxed); };
    sigemptyset(&sa.sa_mask);
    sa.sa_flags = 0;
    sigaction(SIGTERM, &sa, nullptr);
    sigaction(SIGINT, &sa, nullptr);

    curl_global_init(CURL_GLOBAL_DEFAULT);
    int exitCode = 0;

    try {
        auto cfg = loadConfig(argc, argv);
        std::string cmd = argv[1];

        if (cmd == "once") {
            ScraperEngine engine(cfg);
            engine.runOnce();
        } else if (cmd == "daemon") {
            int interval = 60;
            // 解析 --interval 参数
            for (int i = 2; i < argc - 1; ++i) {
                std::string arg = argv[i];
                if (arg == "--interval") {
                    interval = std::atoi(argv[i + 1]);
                    if (interval <= 0) interval = 60;
                }
            }
            ScraperEngine engine(cfg);
            engine.runDaemon(interval);
        } else if (cmd == "query" && argc >= 4) {
            MetadataResolver resolver(cfg);
            TrackInfo track;
            track.id = "debug";
            track.artist = argv[2];
            track.title = argv[3];
            auto result = resolver.resolve(track);
            std::cout << "查询: " << track.artist << " - " << track.title << "\n";
            if (result.title) std::cout << "  标题: " << *result.title << "\n";
            if (result.artist) std::cout << "  艺术家: " << *result.artist << "\n";
            if (result.album) std::cout << "  专辑: " << *result.album << "\n";
            if (result.mbid) std::cout << "  MBID: " << *result.mbid << "\n";
            if (result.isrc) std::cout << "  ISRC: " << *result.isrc << "\n";
            if (result.albumMbid) std::cout << "  Album MBID: " << *result.albumMbid << "\n";
            if (result.artistMbid) std::cout << "  Artist MBID: " << *result.artistMbid << "\n";
            if (result.genre) std::cout << "  流派: " << *result.genre << "\n";
            if (result.label) std::cout << "  唱片公司: " << *result.label << "\n";
            if (!result.coverData.empty()) std::cout << "  封面: " << result.coverData.size() << " bytes\n";
            if (result.lyrics) std::cout << "  歌词: " << result.lyrics->size() << " chars\n";
            if (result.scrapedSources.empty()) {
                std::cout << "  (未找到匹配)\n";
            } else {
                std::cout << "  数据源:";
                for (const auto& s : result.scrapedSources) std::cout << " " << s;
                std::cout << "\n";
            }
        } else if (cmd == "-h" || cmd == "--help" || cmd == "help") {
            printUsage();
        } else {
            std::cerr << "未知命令: " << cmd << "\n\n";
            printUsage();
            exitCode = 1;
        }
    } catch (const std::exception& e) {
        std::cerr << "[scraper] 致命错误: " << e.what() << std::endl;
        exitCode = 1;
    }

    curl_global_cleanup();
    return exitCode;
}
