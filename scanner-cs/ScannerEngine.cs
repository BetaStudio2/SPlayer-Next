using System.Collections.Concurrent;
using System.Diagnostics;
using System.IO;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Threading.Channels;
using TagLibFile = TagLib.File;

namespace SPlayer.Scanner;

/// <summary>
/// 扫描引擎核心
///
/// 职责：
/// 1. 递归收集目录下的音频文件（带安全限制，自动去重）
/// 2. 扫描前创建 SQLite 蓝图表（记录 DB 中现有文件）
/// 3. 用 TagLibSharp 解析元数据 + 提取封面 + 提取歌词
/// 4. 并行解析 + Channel 批量写入 TS 层
/// 5. 每个文件从蓝图中消费移除（原子操作："已处理"持久化）
/// 6. 扫描后清理蓝图残留（＝磁盘已删除的曲目）
/// 7. 通过 stdout 输出 JSON 进度（TS 层监听）
///
/// 蓝图崩溃安全：扫描崩溃后蓝图表仍存在 DB 中，
/// 下次扫描会重建蓝图（DROP + CREATE），不会丢失"已处理"状态判定。
/// </summary>
public sealed class ScannerEngine
{
    /// <summary>支持的音频扩展名（小写，无点）</summary>
    private static readonly HashSet<string> AudioExt = new(StringComparer.OrdinalIgnoreCase)
    {
        "mp3", "flac", "ogg", "opus", "oga", "m4a", "aac", "wav",
        "ape", "wv", "dsf", "dsd", "dff", "mp4", "aiff", "aif",
    };

    private readonly IScannerDatabase _db;
    private readonly string _coverCacheDir;
    private readonly int _batchSize;
    private readonly bool _incremental;

    private readonly long _maxFileSizeBytes;
    private readonly int _maxScanFiles;
    private readonly int _maxScanErrors;
    private readonly int _maxParallelism;
    private readonly object _lock = new();

    public ScannerEngine(
        IScannerDatabase db,
        string coverCacheDir,
        int batchSize = 50,
        bool incremental = true,
        long? maxFileSizeBytes = null,
        int? maxScanFiles = null,
        int? maxScanErrors = null,
        int? maxParallelism = null)
    {
        _db = db;
        _coverCacheDir = coverCacheDir;
        _batchSize = Math.Max(1, batchSize);
        _incremental = incremental;

        // 安全限制：默认与 C++ 刮削器保持一致
        _maxFileSizeBytes = maxFileSizeBytes ?? (500L * 1024 * 1024);
        _maxScanFiles = maxScanFiles ?? 50000;
        _maxScanErrors = maxScanErrors ?? 50;
        _maxParallelism = maxParallelism ?? AdaptiveConcurrency.ForIOBound();
    }

    /// <summary>
    /// 启动扫描
    ///
    /// 扫描流程（蓝图驱动）：
    ///   1. 递归收集文件
    ///   2. 创建蓝图表（复制 DB 中所有文件路径 + mtime + size 到临时表）
    ///   3. 并行解析文件，每文件调用 BlueprintConsume（原子移除 + 增量比对）
    ///   4. 批量 upsert 新/变更的数据
    ///   5. BlueprintCleanup：蓝图残留 = 磁盘已删除 → 清理 DB 记录
    /// </summary>
    public async Task<ScanResult> ScanAsync(List<string> dirs, CancellationToken ct = default)
    {
        var sw = Stopwatch.StartNew();
        var result = new ScanResult();
        var progress = new ScanProgress { Scanning = true, StartedAt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() };

        // 1. 收集文件（自动去重，防止重叠目录导致同一文件被处理两次）
        LogInfo($"开始扫描 (incremental={_incremental}, parallelism={_maxParallelism}): {string.Join(", ", dirs)}");
        var files = await CollectFilesAsync(dirs, ct);
        if (files.Count > _maxScanFiles)
        {
            LogWarn($"文件数量 {files.Count} 超过上限 {_maxScanFiles}，将截断处理");
            files = files.Take(_maxScanFiles).ToList();
        }
        progress.Total = files.Count;
        EmitProgress(progress);
        LogInfo($"发现 {files.Count} 个音频文件");

        // 2. 创建蓝图表（SQLite 临时表，记录 DB 中现有文件路径 + mtime + size）
        //    崩溃安全：即使进程 crash，蓝图仍留在 DB 中
        bool blueprintOk = false;
        LogInfo("创建扫描蓝图表...");
        try { await _db.BlueprintInitAsync(ct); blueprintOk = true; }
        catch (Exception ex) { LogWarn($"创建蓝图失败，将退化到全量扫描: {ex.Message}"); }

        // 3. 并行解析 + Channel 批量写入
        var channel = Channel.CreateUnbounded<TrackMetadata>(new UnboundedChannelOptions { SingleWriter = false });
        var writer = Task.Run(async () => await ChannelWriterAsync(channel.Reader, result, ct), ct);

        var parserOptions = new ParallelOptions
        {
            MaxDegreeOfParallelism = _maxParallelism,
            CancellationToken = ct,
        };

        // seenPaths：线程安全地跟踪已处理文件，防止 Parallel.ForEachAsync 重复处理
        var seenPaths = new ConcurrentDictionary<string, byte>(StringComparer.OrdinalIgnoreCase);

        int consecutiveErrors = 0;
        var lastEmit = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();

        try
        {
            await Parallel.ForEachAsync(files, parserOptions, async (file, itemCt) =>
            {
                itemCt.ThrowIfCancellationRequested();

                // 防止重复处理：同一路径只处理一次
                if (!seenPaths.TryAdd(file, 0))
                    return;

                lock (_lock) { progress.Current = file; }

                // 从蓝图中消费此路径（原子操作：移除 + 增量比对）
                // 始终消费（即使非增量），确保 cleanup 时蓝图只保留"磁盘上不存在"的文件
                bool shouldSkip = false;
                var fi = SafeFileInfo(file);
                if (blueprintOk && fi != null && fi.Exists)
                {
                    try
                    {
                        var consume = await _db.BlueprintConsumeAsync(
                            file, ToUnixMs(fi.LastWriteTimeUtc), fi.Length, itemCt);

                        // 仅 incremental 模式下跳过未变化文件
                        if (_incremental && consume.Exists && consume.Unchanged)
                            shouldSkip = true;
                    }
                    catch (Exception ex)
                    {
                        LogWarn($"蓝图消费失败 {file}: {ex.Message}");
                        // 蓝图不可用 → 退化到全量扫描，不中止
                        blueprintOk = false;
                    }
                }
                if (shouldSkip)
                {
                    lock (_lock) { progress.Scanned++; result.Scanned++; }
                    TryEmitProgress(ref lastEmit, progress, result);
                    return;
                }

                var track = await Task.Run(() => ParseFile(file), itemCt);
                if (track != null)
                {
                    lock (_lock) { consecutiveErrors = 0; }
                    await channel.Writer.WriteAsync(track, itemCt);
                    lock (_lock) { result.Upserted++; }
                }
                else
                {
                    int errCount;
                    lock (_lock) { errCount = ++consecutiveErrors; }
                    lock (_lock) { result.Errors++; }
                    if (errCount >= _maxScanErrors)
                    {
                        LogError($"连续失败达到上限 {_maxScanErrors}，中止扫描");
                        throw new InvalidOperationException($"连续解析失败超过 {_maxScanErrors} 次");
                    }
                }

                lock (_lock) { progress.Scanned++; result.Scanned++; }
                TryEmitProgress(ref lastEmit, progress, result);
            });
        }
        catch (OperationCanceledException)
        {
            // 正常取消，不记为错误
        }
        catch (Exception ex)
        {
            LogError($"扫描异常: {ex.Message}");
            result.Errors++;
        }
        finally
        {
            channel.Writer.Complete();
        }

        await writer;

        // 4. 清理蓝图残留（＝存在于 DB 但磁盘上已删除的文件）
        if (!ct.IsCancellationRequested)
        {
            try
            {
                var deleted = await _db.BlueprintCleanupAsync(ct);
                if (deleted > 0)
                {
                    result.Deleted = deleted;
                    LogInfo($"清理 {deleted} 条失效记录");
                }
            }
            catch (Exception ex)
            {
                LogError($"清理失效记录失败: {ex.Message}");
            }
        }

        result.Total = files.Count;
        result.Canceled = ct.IsCancellationRequested;
        sw.Stop();
        LogInfo($"扫描完成: {result.Scanned}/{result.Total}（upsert={result.Upserted}, delete={result.Deleted}, errors={result.Errors}, {sw.ElapsedMilliseconds}ms）");
        return result;
    }

    /// <summary>
    /// Channel 消费者：攒批写入 TS 层
    /// </summary>
    private async Task ChannelWriterAsync(ChannelReader<TrackMetadata> reader, ScanResult result, CancellationToken ct)
    {
        var batch = new List<TrackMetadata>(_batchSize);
        await foreach (var track in reader.ReadAllAsync(ct))
        {
            batch.Add(track);
            if (batch.Count >= _batchSize)
                await FlushBatchAsync(batch, result, ct);
        }
        if (batch.Count > 0)
            await FlushBatchAsync(batch, result, ct);
    }

    private async Task FlushBatchAsync(List<TrackMetadata> batch, ScanResult result, CancellationToken ct)
    {
        try
        {
            await _db.UpsertTracksAsync(batch, ct);
        }
        catch (Exception ex)
        {
            LogError($"批量写入失败: {ex.Message}");
            lock (_lock) { result.Errors += batch.Count; }
        }
        finally
        {
            batch.Clear();
        }
    }

    /// <summary>
    /// 递归收集音频文件
    /// </summary>
    private async Task<List<string>> CollectFilesAsync(List<string> dirs, CancellationToken ct)
    {
        var result = new List<string>();
        foreach (var dir in dirs)
        {
            if (ct.IsCancellationRequested) break;
            await WalkAsync(dir, result, ct);
            if (result.Count >= _maxScanFiles) break;
        }
        return result;
    }

    private async Task WalkAsync(string dir, List<string> result, CancellationToken ct)
    {
        IEnumerable<string> entries;
        try { entries = Directory.EnumerateFileSystemEntries(dir, "*", new EnumerationOptions { IgnoreInaccessible = true, RecurseSubdirectories = false }); }
        catch (UnauthorizedAccessException) { return; }
        catch (DirectoryNotFoundException) { return; }

        foreach (var full in entries)
        {
            if (ct.IsCancellationRequested) return;
            if (result.Count >= _maxScanFiles) return;

            try
            {
                var attr = File.GetAttributes(full);
                if (attr.HasFlag(FileAttributes.Directory))
                {
                    await WalkAsync(full, result, ct);
                }
                else
                {
                    var ext = Path.GetExtension(full).TrimStart('.').ToLowerInvariant();
                    if (AudioExt.Contains(ext))
                        result.Add(full);
                }
            }
            catch { /* 软链接/权限等跳过 */ }
        }
    }

    /// <summary>
    /// 解析单个音频文件
    /// </summary>
    private TrackMetadata? ParseFile(string filePath)
    {
        var info = SafeFileInfo(filePath);
        if (info == null || !info.Exists) return null;

        // 安全预检：跳过空文件 / 超大文件
        if (info.Length == 0 || info.Length > _maxFileSizeBytes)
        {
            LogWarn($"跳过异常文件 {filePath}: size={info.Length}");
            return null;
        }

        TagLibFile tag;
        try
        {
            tag = TagLibFile.Create(filePath);
        }
        catch (Exception ex)
        {
            LogWarn($"解析失败 {filePath}: {ex.Message}");
            return null;
        }

        var id = Md5Hex(filePath);
        var props = tag.Properties;
        var audioProps = props.AudioSampleRate > 0 ? props : null;

        // 标题
        var title = string.IsNullOrWhiteSpace(tag.Tag.Title)
            ? Path.GetFileNameWithoutExtension(filePath)
            : tag.Tag.Title;

        // 歌手
        var artists = tag.Tag.Performers?
            .Where(n => !string.IsNullOrWhiteSpace(n))
            .Select(n => new ArtistRef { Name = n })
            .ToList();
        if (artists == null || artists.Count == 0)
            artists = new List<ArtistRef> { new() { Name = "未知歌手" } };

        // 专辑
        AlbumRef? album = null;
        if (!string.IsNullOrWhiteSpace(tag.Tag.Album))
        {
            album = new AlbumRef
            {
                Name = tag.Tag.Album,
                Year = tag.Tag.Year > 0 ? (int?)tag.Tag.Year : null,
                Artist = tag.Tag.Performers?.FirstOrDefault(),
            };
        }

        // 时长（毫秒）
        var duration = (long)Math.Round(tag.Properties.Duration.TotalMilliseconds);

        // 封面（统一写 ${id}.img，与 TS 层 serveTrackCover 读取路径一致）
        string? cover = null;
        var pictures = tag.Tag.Pictures;
        if (pictures != null && pictures.Length > 0)
        {
            try
            {
                Directory.CreateDirectory(_coverCacheDir);
                var coverPath = Path.Combine(_coverCacheDir, $"{id}.img");
                var pic = pictures[0];
                File.WriteAllBytes(coverPath, pic.Data.Data);
                cover = $"/api/music/cover/{id}";
            }
            catch (Exception ex)
            {
                LogWarn($"封面写入失败 {filePath}: {ex.Message}");
            }
        }

        // 歌词（TagLibSharp 2.3.0 中 Tag.Lyrics 是 string，不是 string[]）
        var lyricsRaw = tag.Tag.Lyrics;
        string? lyrics = string.IsNullOrWhiteSpace(lyricsRaw) ? null : lyricsRaw.Trim();

        // 编解码信息
        var codec = audioProps?.Description;
        var sampleRate = audioProps?.AudioSampleRate > 0 ? audioProps?.AudioSampleRate : null;
        var bitRate = audioProps?.AudioBitrate > 0 ? audioProps?.AudioBitrate : null;
        var channels = audioProps?.AudioChannels > 0 ? audioProps?.AudioChannels : null;
        var bitsPerSample = audioProps?.BitsPerSample > 0 ? audioProps?.BitsPerSample : null;

        return new TrackMetadata
        {
            Id = id,
            Path = filePath,
            Title = title,
            Track = tag.Tag.Track > 0 ? (int?)tag.Tag.Track : null,
            Artists = artists,
            Album = album,
            Duration = duration,
            Cover = cover,
            Codec = codec,
            SampleRate = sampleRate,
            BitRate = bitRate,
            Channels = channels,
            BitsPerSample = bitsPerSample,
            FileSize = info.Length,
            Mtime = ToUnixMs(info.LastWriteTimeUtc),
            Ctime = ToUnixMs(info.CreationTimeUtc),
            Lyrics = lyrics,
        };
    }

    /* ------------------------------------------------------------------ */
    /* 工具                                                                */
    /* ------------------------------------------------------------------ */

    private static FileInfo? SafeFileInfo(string path)
    {
        try { return new FileInfo(path); }
        catch { return null; }
    }

    private void TryEmitProgress(ref long lastEmit, ScanProgress p, ScanResult result)
    {
        p.Upserted = result.Upserted;
        p.Errors = result.Errors;
        var now = NowMs();
        if (now - lastEmit > 500)
        {
            EmitProgress(p);
            lastEmit = now;
        }
    }

    private static string Md5Hex(string input)
    {
        var bytes = MD5.HashData(Encoding.UTF8.GetBytes(input));
        return Convert.ToHexString(bytes).ToLowerInvariant();
    }

    private static long ToUnixMs(DateTime dt)
    {
        return new DateTimeOffset(dt).ToUnixTimeMilliseconds();
    }

    private static long NowMs() => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();

    private static void EmitProgress(ScanProgress p)
    {
        // stdout 输出 JSON（TS 层监听）
        Console.WriteLine(JsonSerializer.Serialize(p, ScannerJsonOptions.Default));
    }

    private static void LogInfo(string msg) => Console.Error.WriteLine($"[scanner] {msg}");
    private static void LogWarn(string msg) => Console.Error.WriteLine($"[scanner] WARN: {msg}");
    private static void LogError(string msg) => Console.Error.WriteLine($"[scanner] ERROR: {msg}");
}
