/**
 * WebSocket 服务
 *
 * 连接路径：GET /ws（由 HTTP server 的 upgrade 事件分流）
 *
 * 服务端 → 客户端推送：
 *   { type: "scan:progress", data: ScanProgress }
 *   { type: "scan:done",     data: { total, scanned, canceled } }
 *   { type: "library:changed", data: { action, path } }
 *
 * 客户端 → 服务端：
 *   { type: "ping" }          → 回 { type: "pong" }
 *   { type: "scan:progress" } → 回当前快照
 */
import type { Server } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { subscribe } from "@main/utils/events";
import { getScanProgress } from "@main/music/scanner";
import { getScrapeProgress } from "@main/music/scraper";
import { serverLog } from "@main/utils/logger";

/** 全局 WebSocketServer 实例 */
let globalWss: WebSocketServer | null = null;

/** 获取全局 WebSocketServer 实例 */
export const getWebSocketServer = (): WebSocketServer | null => globalWss;

/** 向指定流广播消息 */
export const broadcastToStream = (streamId: string, message: Record<string, unknown>): void => {
  if (!globalWss) return;
  const payload = JSON.stringify({ ...message, streamId });
  for (const client of globalWss.clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(payload);
    }
  }
};

/**
 * 把 WebSocket 服务挂到已有 HTTP server 上
 * @param server @hono/node-server 返回的 http.Server 实例
 * @returns WebSocketServer 实例（可用于 wss.close()）
 */
export const attachWebSocket = (server: Server): WebSocketServer => {
  const wss = new WebSocketServer({ noServer: true });
  globalWss = wss;

  // 拦截 HTTP server 的 upgrade 事件，仅处理 /ws 路径
  server.on("upgrade", (req, socket, head) => {
    const pathname = new URL(req.url ?? "", "http://localhost").pathname;
    if (pathname !== "/ws") {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  });

  wss.on("connection", (ws) => {
    // 连接建立即推送当前扫描/刮削快照，避免客户端空等
    ws.send(JSON.stringify({ type: "scan:progress", data: getScanProgress() }));
    ws.send(JSON.stringify({ type: "scrape:progress", data: getScrapeProgress() }));

    // 订阅事件总线，转发给该客户端
    const unsub = subscribe((event) => {
      if (ws.readyState === WebSocket.OPEN) {
        try {
          ws.send(JSON.stringify(event));
        } catch {
          /* 连接已关闭 */
        }
      }
    });

    ws.on("message", (raw) => {
      try {
        const msg = JSON.parse(raw.toString()) as { type?: string };
        if (msg.type === "ping") {
          ws.send(JSON.stringify({ type: "pong" }));
        } else if (msg.type === "scan:progress") {
          ws.send(
            JSON.stringify({ type: "scan:progress", data: getScanProgress() }),
          );
        } else if (msg.type === "scrape:progress") {
          ws.send(
            JSON.stringify({ type: "scrape:progress", data: getScrapeProgress() }),
          );
        }
      } catch {
        /* 非 JSON 文本，忽略 */
      }
    });

    ws.on("close", () => unsub());
    serverLog.debug("[ws] client connected");
  });

  serverLog.info("[ws] websocket server attached at /ws");
  return wss;
};
