/**
 * WebSocket 连接管理器
 *
 * 用于接收服务端推送的事件（刮削进度、扫描进度等）。
 * 仅在 Web 服务端模式下使用，Electron 桌面模式走 IPC。
 */
import { isElectron } from "@/utils/config";

export interface ServerEvent {
  type: "scan:progress" | "scan:done" | "scrape:progress" | "scrape:done" | "library:changed";
  data: unknown;
}

type EventHandler = (data: unknown) => void;

class WebSocketManager {
  private ws: WebSocket | null = null;
  private handlers = new Map<string, Set<EventHandler>>();
  private reconnectTimer: number | null = null;
  private reconnectDelay = 1000;
  private maxReconnectDelay = 30000;

  /** 连接 WebSocket */
  connect(): void {
    if (isElectron || this.ws) return;

    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const wsUrl = `${protocol}//${window.location.host}/ws`;

    try {
      this.ws = new WebSocket(wsUrl);

      this.ws.onopen = () => {
        console.log("[ws] connected");
        this.reconnectDelay = 1000;
      };

      this.ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data) as ServerEvent;
          this.emit(msg.type, msg.data);
        } catch (err) {
          console.warn("[ws] parse error:", err);
        }
      };

      this.ws.onclose = () => {
        console.log("[ws] disconnected");
        this.ws = null;
        this.scheduleReconnect();
      };

      this.ws.onerror = (err) => {
        console.error("[ws] error:", err);
      };
    } catch (err) {
      console.error("[ws] connect failed:", err);
      this.scheduleReconnect();
    }
  }

  /** 断开连接 */
  disconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  /** 订阅事件 */
  on(type: string, handler: EventHandler): () => void {
    if (!this.handlers.has(type)) {
      this.handlers.set(type, new Set());
    }
    this.handlers.get(type)!.add(handler);

    return () => {
      this.handlers.get(type)?.delete(handler);
    };
  }

  /** 发送消息 */
  send(data: string): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(data);
    }
  }

  /** 发送事件 */
  private emit(type: string, data: unknown): void {
    this.handlers.get(type)?.forEach((handler) => {
      try {
        handler(data);
      } catch (err) {
        console.error(`[ws] handler error [${type}]:`, err);
      }
    });
  }

  /** 计划重连 */
  private scheduleReconnect(): void {
    if (this.reconnectTimer || isElectron) return;

    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, this.reconnectDelay);

    this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.maxReconnectDelay);
  }
}

/** 全局 WebSocket 管理器实例 */
export const wsManager = new WebSocketManager();

/** 初始化 WebSocket 连接（Web 模式下自动调用） */
export const initWebSocket = (): void => {
  if (!isElectron) {
    wsManager.connect();
  }
};
