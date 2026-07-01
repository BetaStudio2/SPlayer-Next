namespace SPlayer.Scanner;

/// <summary>
/// 扫描器数据库操作抽象
///
/// 两种实现：
///   DbProxyClient    — HTTP 代理写入（默认，通过 Node.js better-sqlite3）
///   SqliteDirectWriter — 直写 SQLite（SPLAYER_DB_PATH 设置时启用，绕过 V8 堆）
/// </summary>
public interface IScannerDatabase
{
    Task UpsertTracksAsync(List<TrackMetadata> tracks, CancellationToken ct = default);
    Task BlueprintInitAsync(CancellationToken ct = default);
    Task<BlueprintConsumeResult> BlueprintConsumeAsync(string path, long? mtime = null, long? size = null, CancellationToken ct = default);
    Task<int> BlueprintCleanupAsync(CancellationToken ct = default);
}
