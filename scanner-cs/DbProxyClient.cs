using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;

namespace SPlayer.Scanner;

/// <summary>
/// TS 层 SQLite 写入代理客户端
///
/// 所有写操作通过 HTTP POST 发送到 /api/db/*，
/// 由 TS 层 better-sqlite3 同步 API 串行化写入，避免多进程 SQLITE_BUSY。
/// </summary>
public sealed class DbProxyClient : IScannerDatabase, IDisposable
{
    private readonly HttpClient _http;
    private readonly string _baseUrl;
    private readonly int _timeoutMs;

    /// <param name="baseUrl">TS 层 API 地址</param>
    /// <param name="proxyKey">写入代理密钥</param>
    /// <param name="timeoutMs">单次 DB 写入超时（毫秒），0 = 禁用，-1 = 默认自动（最低 30s）</param>
    public DbProxyClient(string baseUrl, string proxyKey, int timeoutMs = 0)
    {
        _baseUrl = baseUrl.TrimEnd('/');
        _timeoutMs = timeoutMs;
        _http = new HttpClient();
        _http.DefaultRequestHeaders.Add("x-proxy-key", proxyKey);
        _http.Timeout = System.Threading.Timeout.InfiniteTimeSpan;
    }

    /// <summary>
    /// 根据批量大小和配置计算单次请求超时。
    /// timeoutMs = 0（默认）→ 禁用，不设置 CancelAfter。
    /// timeoutMs = -1 → 自动：最低 30s + 每条 100ms。
    /// timeoutMs > 0 → 使用指定值。
    /// </summary>
    private TimeSpan? GetTimeout(int batchSize)
    {
        if (_timeoutMs == 0) return null; // 禁用
        if (_timeoutMs > 0) return TimeSpan.FromMilliseconds(_timeoutMs);
        // -1：自动计算
        var seconds = Math.Max(30, 10 + batchSize / 10);
        return TimeSpan.FromSeconds(seconds);
    }

    /// <summary>
    /// 对 CancellationTokenSource 应用超时（若配置了）
    /// </summary>
    private void ApplyTimeout(CancellationTokenSource cts, int batchSize)
    {
        var timeout = GetTimeout(batchSize);
        if (timeout.HasValue)
            cts.CancelAfter(timeout.Value);
    }

    /// <summary>
    /// 批量 upsert 曲目（POST /api/db/upsert）
    /// </summary>
    public async Task UpsertTracksAsync(List<TrackMetadata> tracks, CancellationToken ct = default)
    {
        if (tracks.Count == 0) return;
        var json = JsonSerializer.Serialize(tracks, ScannerJsonOptions.Default);
        var content = new StringContent(json, Encoding.UTF8, new MediaTypeHeaderValue("application/json"));
        using var cts = CancellationTokenSource.CreateLinkedTokenSource(ct);
        ApplyTimeout(cts, tracks.Count);
        var resp = await _http.PostAsync($"{_baseUrl}/api/db/upsert", content, cts.Token);
        resp.EnsureSuccessStatusCode();
    }

    /* ------------------------------------------------------------------ */
    /* 蓝图表操作（Blueprint）                                               */
    /* ------------------------------------------------------------------ */

    /// <summary>
    /// 初始化蓝图表：将当前 DB 中所有文件路径 + mtime + size 复制到临时表。
    ///（POST /api/db/blueprint/init）
    /// </summary>
    public async Task BlueprintInitAsync(CancellationToken ct = default)
    {
        using var cts = CancellationTokenSource.CreateLinkedTokenSource(ct);
        ApplyTimeout(cts, 0);
        var resp = await _http.PostAsync($"{_baseUrl}/api/db/blueprint/init", null, cts.Token);
        resp.EnsureSuccessStatusCode();
    }

    /// <summary>
    /// 消费蓝图中的一条路径：检查是否在蓝图中，比对 mtime+size，并从蓝图移除。
    ///（POST /api/db/blueprint/consume）
    ///
    /// 返回：
    ///   (exists: true, unchanged: true)  → 文件未变，跳过
    ///   (exists: true, unchanged: false) → 文件已变，需重新解析入库
    ///   (exists: false)                  → 新文件，需入库
    /// </summary>
    public async Task<BlueprintConsumeResult> BlueprintConsumeAsync(
        string path, long? mtime = null, long? size = null, CancellationToken ct = default)
    {
        var body = new Dictionary<string, object?> { ["path"] = path };
        if (mtime.HasValue) body["mtime"] = mtime;
        if (size.HasValue) body["size"] = size;
        var json = JsonSerializer.Serialize(body, ScannerJsonOptions.Default);
        var content = new StringContent(json, Encoding.UTF8, new MediaTypeHeaderValue("application/json"));
        using var cts = CancellationTokenSource.CreateLinkedTokenSource(ct);
        ApplyTimeout(cts, 0);
        var resp = await _http.PostAsync($"{_baseUrl}/api/db/blueprint/consume", content, cts.Token);
        resp.EnsureSuccessStatusCode();
        var respJson = await resp.Content.ReadAsStringAsync(cts.Token);
        var result = JsonSerializer.Deserialize<BlueprintConsumeResponse>(respJson, ScannerJsonOptions.Default);
        if (result == null || !result.Ok)
            throw new InvalidOperationException("blueprint consume 失败");
        return new BlueprintConsumeResult
        {
            Exists = result.Exists,
            Unchanged = result.Unchanged,
        };
    }

    /// <summary>
    /// 清理蓝图中残留的曲目（＝磁盘已删除），并销毁蓝图表。
    ///（POST /api/db/blueprint/cleanup）
    /// 返回被清理的曲目数。
    /// </summary>
    public async Task<int> BlueprintCleanupAsync(CancellationToken ct = default)
    {
        using var cts = CancellationTokenSource.CreateLinkedTokenSource(ct);
        ApplyTimeout(cts, 0);
        var resp = await _http.PostAsync($"{_baseUrl}/api/db/blueprint/cleanup", null, cts.Token);
        resp.EnsureSuccessStatusCode();
        var json = await resp.Content.ReadAsStringAsync(cts.Token);
        var result = JsonSerializer.Deserialize<BlueprintCleanupResponse>(json, ScannerJsonOptions.Default);
        return result?.Deleted ?? 0;
    }

    public void Dispose() => _http.Dispose();

    /* ------------------------------------------------------------------ */
    /* 内嵌模型                                                            */
    /* ------------------------------------------------------------------ */

    private sealed class BlueprintConsumeResponse
    {
        public bool Ok { get; set; }
        public bool Exists { get; set; }
        public bool Unchanged { get; set; }
    }

    private sealed class BlueprintCleanupResponse
    {
        public bool Ok { get; set; }
        public int Deleted { get; set; }
    }
}

/// <summary>
/// 蓝图消费结果
/// </summary>
public sealed class BlueprintConsumeResult
{
    public bool Exists { get; set; }
    public bool Unchanged { get; set; }
}

/// <summary>
/// JSON 序列化选项（camelCase，与 TS 层一致）
/// </summary>
public static class ScannerJsonOptions
{
    public static readonly JsonSerializerOptions Default = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        DefaultIgnoreCondition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull,
    };
}
