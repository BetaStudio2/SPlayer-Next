using System.Collections.Concurrent;
using System.Text.Json;
using Microsoft.Data.Sqlite;

namespace SPlayer.Scanner;

/// <summary>
/// SQLite 直写器
///
/// 替代 DbProxyClient，扫描器直接打开 SQLite 写入，数据不经过 Node.js / V8 堆。
/// 使用 WAL 模式与 Node.js better-sqlite3 共享同一个 DB 文件。
///
/// 写入仅涉及扫描器负责的字段，不覆盖刮削器写入的字段（mbid/isrc/genre 等）。
///
/// 蓝图策略（两层）：
///   1. 内存 ConcurrentDictionary — zero-lock per-file TryRemove，并发安全
///   2. SQLite _scanner_blueprint — 崩溃恢复：进程 crash 后重启扫描仍可用
///   BlueprintInit 同时填充两层，BlueprintConsume 仅操作内存（无 SQLite），
///   BlueprintCleanup 从内存残差取删除列表，SQLite 表用于急救场景。
/// </summary>
public sealed class SqliteDirectWriter : IScannerDatabase, IDisposable
{
    private readonly SqliteConnection _conn;
    /// <summary>保护 SQLite 写操作（upsert / init / cleanup / blueprint DDL）</summary>
    private readonly object _writeLock = new();

    /// <summary>内存蓝图：path → (mtime, size)。init 时填充，consume 时 TryRemove，cleanup 时残差 = 删除</summary>
    private ConcurrentDictionary<string, (long Mtime, long Size)>? _blueprint;

    public SqliteDirectWriter(string dbPath)
    {
        _conn = new SqliteConnection($"Data Source={dbPath}");
        _conn.Open();

        using var pragma = _conn.CreateCommand();
        pragma.CommandText = "PRAGMA journal_mode = WAL";
        pragma.ExecuteNonQuery();
    }

    // ---- IScannerDatabase 异步包装 ----

    public Task UpsertTracksAsync(List<TrackMetadata> tracks, CancellationToken ct = default)
    {
        if (tracks.Count == 0) return Task.CompletedTask;
        return Task.Run(() => UpsertTracks(tracks, ct), ct);
    }

    public Task BlueprintInitAsync(CancellationToken ct = default)
    {
        return Task.Run(() => BlueprintInit(ct), ct);
    }

    /// <summary>
    /// 零锁内存比对：直接从 ConcurrentDictionary TryRemove。
    /// 不访问 SQLite，不阻塞其他并行任务。
    ///
    /// mtime 为 0 表示旧记录无时间戳（升级前的 DB），视为"可能变化"，
    /// 谨慎起见不做跳过，保证一次全量刷新后即可正常增量。
    /// </summary>
    public Task<BlueprintConsumeResult> BlueprintConsumeAsync(
        string path, long? mtime = null, long? size = null, CancellationToken ct = default)
    {
        ct.ThrowIfCancellationRequested();

        var bp = _blueprint;
        if (bp == null)
            return Task.FromResult(new BlueprintConsumeResult { Exists = false, Unchanged = false });

        if (!bp.TryRemove(path, out var cached))
            return Task.FromResult(new BlueprintConsumeResult { Exists = false, Unchanged = false });

        // 旧记录可能 mtime=0（升级前的 DB），此时不做跳过，触发一次重新解析
        // 解析后 mtime/size 就会写入 DB，下一次增量扫描就能正常跳过了
        var unchanged = mtime.HasValue && size.HasValue
            && cached.Mtime > 0
            && cached.Mtime == mtime.Value
            && cached.Size == size.Value;

        return Task.FromResult(new BlueprintConsumeResult { Exists = true, Unchanged = unchanged });
    }

    public Task<int> BlueprintCleanupAsync(CancellationToken ct = default)
    {
        return Task.Run(() => BlueprintCleanup(ct), ct);
    }

    // ---- 内部同步方法 ----

    private void UpsertTracks(List<TrackMetadata> tracks, CancellationToken ct)
    {
        lock (_writeLock)
        {
            using var tx = _conn.BeginTransaction();
            using var cmd = _conn.CreateCommand();
            cmd.CommandText = @"
                INSERT INTO tracks
                    (id, path, title, track, artists, album, duration, cover,
                     codec, sample_rate, bit_rate, channels, bits_per_sample,
                     file_size, file_mtime, file_ctime, scanned_at, lyrics)
                VALUES
                    (@id, @path, @title, @track, @artists, @album, @duration, @cover,
                     @codec, @sampleRate, @bitRate, @channels, @bitsPerSample,
                     @fileSize, @fileMtime, @fileCtime, @scannedAt, @lyrics)
                ON CONFLICT(id) DO UPDATE SET
                    path = excluded.path,
                    title = excluded.title,
                    track = excluded.track,
                    artists = excluded.artists,
                    album = excluded.album,
                    duration = excluded.duration,
                    cover = excluded.cover,
                    codec = excluded.codec,
                    sample_rate = excluded.sample_rate,
                    bit_rate = excluded.bit_rate,
                    channels = excluded.channels,
                    bits_per_sample = excluded.bits_per_sample,
                    file_size = excluded.file_size,
                    file_mtime = excluded.file_mtime,
                    file_ctime = excluded.file_ctime,
                    scanned_at = excluded.scanned_at,
                    lyrics = excluded.lyrics
            ";

            var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();

            foreach (var t in tracks)
            {
                ct.ThrowIfCancellationRequested();

                cmd.Parameters.Clear();
                cmd.Parameters.AddWithValue("@id", t.Id);
                cmd.Parameters.AddWithValue("@path", t.Path);
                cmd.Parameters.AddWithValue("@title", t.Title);
                cmd.Parameters.AddWithValue("@track", (object?)t.Track ?? DBNull.Value);
                cmd.Parameters.AddWithValue("@artists", JsonSerializer.Serialize(t.Artists));
                cmd.Parameters.AddWithValue("@album", t.Album != null ? JsonSerializer.Serialize(t.Album) : DBNull.Value);
                cmd.Parameters.AddWithValue("@duration", t.Duration);
                cmd.Parameters.AddWithValue("@cover", (object?)t.Cover ?? DBNull.Value);
                cmd.Parameters.AddWithValue("@codec", (object?)t.Codec ?? DBNull.Value);
                cmd.Parameters.AddWithValue("@sampleRate", (object?)t.SampleRate ?? DBNull.Value);
                cmd.Parameters.AddWithValue("@bitRate", (object?)t.BitRate ?? DBNull.Value);
                cmd.Parameters.AddWithValue("@channels", (object?)t.Channels ?? DBNull.Value);
                cmd.Parameters.AddWithValue("@bitsPerSample", (object?)t.BitsPerSample ?? DBNull.Value);
                cmd.Parameters.AddWithValue("@fileSize", t.FileSize);
                cmd.Parameters.AddWithValue("@fileMtime", t.Mtime);
                cmd.Parameters.AddWithValue("@fileCtime", t.Ctime);
                cmd.Parameters.AddWithValue("@scannedAt", now);
                cmd.Parameters.AddWithValue("@lyrics", (object?)t.Lyrics ?? DBNull.Value);

                cmd.ExecuteNonQuery();
            }

            tx.Commit();
        }
    }

    /// <summary>
    /// 初始化蓝图：仅加载到内存 ConcurrentDictionary。
    /// 不再写入 SQLite（_scanner_blueprint 表已废弃），
    /// 扫描器 crash 后重启扫描会自动从 tracks 重新加载。
    /// </summary>
    private void BlueprintInit(CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();

        var dict = new ConcurrentDictionary<string, (long, long)>(StringComparer.Ordinal);

        lock (_writeLock)
        {
            using var cmd = _conn.CreateCommand();
            cmd.CommandText = "SELECT path, COALESCE(file_mtime, 0), COALESCE(file_size, 0) FROM tracks";
            using var reader = cmd.ExecuteReader();
            while (reader.Read())
            {
                var path = reader.GetString(0);
                var mtime = reader.GetInt64(1);
                var size = reader.GetInt64(2);
                dict[path] = (mtime, size);
            }
        }

        _blueprint = dict;
    }

    /// <summary>
    /// 清理：内存蓝图中残留 key = 已删除文件。
    /// scrape_queue 孤儿由 Node.js 端 /blueprint/cleanup 处理（独立 scraper-state.db）。
    /// </summary>
    private int BlueprintCleanup(CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();

        var bp = _blueprint;
        _blueprint = null;

        if (bp == null || bp.IsEmpty) return 0;

        var stalePaths = bp.Keys.ToList();

        lock (_writeLock)
        {
            using var tx = _conn.BeginTransaction();
            using var delCmd = _conn.CreateCommand();
            delCmd.CommandText = "DELETE FROM tracks WHERE path = @path";
            var param = delCmd.Parameters.Add("@path", SqliteType.Text);
            foreach (var p in stalePaths)
            {
                param.Value = p;
                delCmd.ExecuteNonQuery();
            }
            tx.Commit();
        }

        return stalePaths.Count;
    }

    public void Dispose()
    {
        _blueprint = null;
        _conn.Close();
        _conn.Dispose();
    }
}
