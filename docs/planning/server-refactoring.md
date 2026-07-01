# 服务端代码重构计划

基于 hybrid 分支相对 upstream/dev 的差异分析（server/ 目录 155 文件，13496 行新增），排除客户端专属部分（web/）与纯 API 平台对接层（apis/netease/modules/ 等），以下是可重构的点。

---

## 1. Subsonic 路由文件拆分

**文件**: `server/routes/subsonic.ts`（1084 行）

**问题**: 单文件过大，混杂 XML 序列化、LRC 歌词处理、数据映射、30+ 端点分发、封面/流媒体服务。

**暂行方案**: 不做运行时解耦，只做目录级文件拆分。引用关系和类型照旧，目标是把 1084 行拆到合理粒度。

```
server/routes/subsonic/
├── index.ts         # 路由挂载 + app.all("/*") 端点分发
├── auth.ts          # 鉴权中间件（authenticate + 中间件）
├── lyrics.ts        # 歌词处理（fetchLyricForTrack / parseLrc / prepareSubsonicLyric / lrcTimeToMs）
├── xml.ts           # XML 序列化（objToXml / toXml / escapeXml）
├── helpers.ts       # 工具函数（collectIds / send / buildBody / serveCover / serveStream）
│                     # + 数据映射（trackToChild / albumListRowToAlbum / artistListRowToArtist）
```

每个文件职责：

| 文件 | 内容 | 预估行数 |
|------|------|----------|
| `index.ts` | 端点分发 switch-case + import 其他模块 | 700 |
| `auth.ts` | `authenticate` + `md5` + 鉴权中间件 | 60 |
| `lyrics.ts` | `fetchLyricForTrack` + `parseLrc` + `prepareSubsonicLyric` + `alignAuxiliaryLines` + `formatLrcTimestamp` + `lrcTimeToMs` | 110 |
| `xml.ts` | `objToXml` + `toXml` + `escapeXml` + `singularMap` | 100 |
| `helpers.ts` | `send` + `buildBody` + `collectIds` + `serveCover` + `serveStream` + `trackToChild` + `albumListRowToAlbum` + `artistListRowToArtist` + 常量（`audioMime`/`OPEN_SUBSONIC_EXTENSIONS`） | 120 |

**收益**:
- 每个文件职责单一，易读易改
- 歌词处理等通用逻辑可被其他模块复用
- 新增端点无需修改大文件
- 未来需要运行时解耦时，模块已拆好，改动面小

---

## 2. 平台 API 缓存统一

**文件**:
- `server/apis/netease/core/cache.ts`
- `server/apis/qqmusic/index.ts`（内联 Map-based LRU）
- `server/apis/kugou/*`（推测类似）

**问题**: 三个平台各自实现独立缓存，逻辑重复（TTL + LRU + 容量限制）。

**建议**: 提取公共缓存模块 `server/apis/common/cache.ts`：

```typescript
export class ApiCache {
  get<T>(key: string): T | undefined;
  set<T>(key: string, value: T, ttl?: number): void;
  clear(): void;
  withDedup<T>(key: string, fn: () => Promise<T>): Promise<T>;  // 并发去重
}
```

**收益**: 消除三份重复代码，统一 TTL 策略和最大条目数。

---

## 3. 子进程管理模式抽取公共模块

**文件**:
- `server/music/scanner.ts` — spawn C# `splayer-scanner`
- `server/routes/download.ts` — spawn Rust `splayer-downloader`

**问题**: 两者都是 spawn 子进程 → 解析 stdout JSON lines → 上报进度 → SIGTERM 取消，模式完全相同但代码独立。

**建议**: 提取 `server/utils/subprocess.ts`：

```typescript
interface SubprocessHandlers {
  onProgress?: (data: Record<string, unknown>) => void;
  onDone?: (data: Record<string, unknown>) => void;
  onError?: (err: Error) => void;
}

export function spawnWithProgress(
  bin: string,
  args: string[],
  handlers: SubprocessHandlers,
  options?: { timeout?: number; cwd?: string },
): { cancel: () => void }
```

**收益**:
- scanner 和 downloader 各减少 ~50 行模板代码
- 统一超时处理、子进程清理逻辑
- 未来新增子进程（如 ffmpeg 转码）开箱即用

---

## 4. 移除冗余转发层

**文件**: `server/music/database.ts`

**问题**: 仅 21 行，全部是 `export { ... } from "@main/database"` 的重导出，没有额外逻辑。

**建议**: 直接删除此文件，将 `routes/music.ts`、`scanner.ts`、`watcher.ts` 中的引用改为直接从 `@main/database` 导入。

---

## 5. LRC 歌词处理抽取到公共歌词模块

**文件**: `server/routes/subsonic.ts`（内联，拆分后归入 `routes/subsonic/lyrics.ts`）

**函数**: `parseLrc` / `formatLrcTimestamp` / `alignAuxiliaryLines` / `prepareSubsonicLyric` / `lrcTimeToMs`

**问题**: 这些函数是通用的 LRC 文本处理逻辑，与 Subsonic 协议无关，却定义在 Subsonic 路由文件中。

**建议**: 等拆分完成后，如果 SPlayer 其他模块（如 lyrics WebSocket 推送）也需要 LRC 处理，再抽取到 `server/apis/common/lyric/lrc.ts`。当前拆分后先留在 `routes/subsonic/lyrics.ts`。

---

## 6. 流媒体 Range 响应服务统一

**文件**:
- `server/music/serve.ts` — `serveTrackStream`
- `server/routes/subsonic.ts` — `serveStream`（拆分后归入 `routes/subsonic/helpers.ts`）

**问题**: 两者都是 Range-aware 音频流响应（parse Range header → createReadStream with start/end → 206/200 响应），逻辑高度相似。

**建议**: 提取公共函数到 `server/utils/stream.ts`。

---

## 7. API 代理层响应结构统一

**文件**: `server/routes/proxy.ts`

**问题**: dispatch 函数对三个平台返回不同结构：

| 平台 | 返回格式 |
|------|----------|
| netease | `{ status, body }` |
| qqmusic | `{ data }` |
| kugou | `{ data }` |

**建议**: 统一为 `{ status, body }`（或 `{ data, error }`），减少调用方的条件判断。

---

## 8. 流媒体凭据纳入统一配置管理

**文件**: `server/routes/streaming.ts`

**问题**: streaming 凭据直接读写 `data/config/streaming.json`，而其他配置通过 `store.get/set`（`config/store.ts`）。加密逻辑散落在两处（`utils/crypto.ts` 和 `routes/streaming.ts`）。

**建议**: 将 streaming 凭据纳入统一 store 管理，或至少抽离加密/解密逻辑到 `utils/crypto.ts` 的统一入口。

---

## 9. Subsonic 成对端点合并

**文件**: `server/routes/subsonic.ts`（拆分后归入 `routes/subsonic/index.ts`）

**问题**: 以下端点对处理逻辑完全相同，仅返回 JSON key 名不同：

| 端点对 | 差异 |
|--------|------|
| `getalbumlist` / `getalbumlist2` | key: `albumList` / `albumList2` |
| `getstarred` / `getstarred2` | key: `starred` / `starred2` |
| `search2` / `search3` | key: `searchResult2` / `searchResult3` |
| `getsimilarartists` / `getsimilarartists2` | key: `similarArtists` / `similarArtists2` |

**建议**: 合并 handler，用映射表输出不同 key。

---

## 10. Track Schema 集中定义

**文件**（分散定义）:
- `server/database/index.ts` — `CREATE TABLE tracks (...)`
- `server/database/queries.ts` — `rowToTrack` / `upsertTracks`
- `server/music/scanner.ts` — `parseToUpsert`

**问题**: 字段名映射、类型转换、默认值散落三处，增删字段需同步修改多处。

**建议**: 创建 `server/database/schema.ts` 集中定义字段映射关系和类型转换函数。



## 优先级建议

| 优先级 | 重构项 | 工作量 | 收益 |
|--------|--------|--------|------|
| **P0** | **① subsonic.ts 拆分** | **中** | **消除 1084 行单文件，提升可维护性** |
| P1 | ③ 子进程公共模块 | 中 | 减少重复代码，统一生命周期管理 |
| P1 | ⑦ API 响应统一 | 小 | 消除调用方条件判断 |
| P2 | ② 平台缓存统一 | 中 | 消除三份重复 LRU 实现 |
| P2 | ⑥ 流媒体 Range 统一 | 小 | 消除两份 HTTP Range 实现 |
| P2 | ⑨ 成对端点合并 | 小 | 减少 switch-case 重复 |
| P3 | ④ 移除转发层 | 极小 | 减一层间接引用 |
| P3 | ⑤ 歌词处理抽取 | 小 | 拆分后视需要再做 |
| P3 | ⑧ 配置管理统一 | 中 | 统一配置访问模式 |
| P3 | ⑩ Schema 集中定义 | 小 | 统一字段定义 |