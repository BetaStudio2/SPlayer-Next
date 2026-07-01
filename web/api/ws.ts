/**
 * 浏览器端 WebSocket 客户端
 *
 * - 自动连接 /ws，断线 3s 后自动重连
 * - 30s 心跳保活
 * - 多模块共享单连接，按事件类型订阅
 *
 * 服务端推送的事件类型见 server/utils/events.ts
 */

/** 服务端推送的事件类型（与 server/utils/events.ts 对齐） */
export interface ServerEvent {
  type:
    | "scan:progress"
    | "scan:done"
    | "library:changed"
    | "download:state"
    | "download:progress"
    | "pong";
  data?: unknown;
}

let socket: WebSocket | null = null;
let reconnectTimer: number | null = null;
let heartbeatTimer: number | null = null;
const listeners = new Set<(event: ServerEvent) => void>();

const HEARTBEAT_INTERVAL = 30_000;
const RECONNECT_DELAY = 3_000;

const startHeartbeat = (): void => {
  if (heartbeatTimer !== null) return;
  heartbeatTimer = window.setInterval(() => {
    if (socket && socket.readyState === WebSocket.OPEN) {
      try {
        socket.send(JSON.stringify({ type: "ping" }));
      } catch {
        /* ignore */
      }
    }
  }, HEARTBEAT_INTERVAL);
};

const ensureSocket = (): void => {
  if (socket) {
    if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
      return;
    }
  }

  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  const url = `${proto}//${window.location.host}/ws`;

  try {
    socket = new WebSocket(url);
  } catch {
    scheduleReconnect();
    return;
  }

  socket.onopen = (): void => {
    if (reconnectTimer !== null) {
      window.clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    startHeartbeat();
  };

  socket.onmessage = (evt: MessageEvent): void => {
    try {
      const event = JSON.parse(
        typeof evt.data === "string" ? evt.data : "",
      ) as ServerEvent;
      listeners.forEach((cb) => {
        try {
          cb(event);
        } catch (err) {
          console.error("[ws] subscriber error", err);
        }
      });
    } catch {
      /* 非 JSON，忽略 */
    }
  };

  socket.onclose = (): void => {
    socket = null;
    if (heartbeatTimer !== null) {
      window.clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
    scheduleReconnect();
  };

  socket.onerror = (): void => {
    // onclose 会随后触发，重连逻辑交给 onclose
    socket?.close();
  };
};

const scheduleReconnect = (): void => {
  if (reconnectTimer !== null) return;
  reconnectTimer = window.setTimeout(() => {
    reconnectTimer = null;
    ensureSocket();
  }, RECONNECT_DELAY);
};

/**
 * 订阅服务端事件
 * @param cb 事件回调
 * @returns 取消订阅函数
 */
export const subscribeServerEvent = (cb: (event: ServerEvent) => void): (() => void) => {
  listeners.add(cb);
  ensureSocket();
  return () => {
    listeners.delete(cb);
  };
};
