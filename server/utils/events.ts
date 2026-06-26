/**
 * 服务端事件总线
 *
 * 各模块（scanner / download / watcher 等）通过 emit() 广播事件，
 * WS 路由订阅后转发给浏览器客户端。
 *
 * 单进程内 EventEmitter，零依赖、低开销。
 */
import { EventEmitter } from "node:events";
import type { ScanProgress } from "@main/music/scanner";
import type { DownloadTask, DownloadProgress } from "@shared/types/download";

/** 服务端向客户端推送的事件类型 */
export type ServerEvent =
  | { type: "scan:progress"; data: ScanProgress }
  | { type: "scan:done"; data: { total: number; scanned: number; canceled: boolean } }
  | { type: "library:changed"; data: { action: "add" | "remove" | "update"; path: string } }
  | { type: "download:state"; data: DownloadTask }
  | { type: "download:progress"; data: DownloadProgress };

const bus = new EventEmitter();
// WS 客户端数量不定，取消监听器上限警告
bus.setMaxListeners(0);

/** 广播一个事件给所有订阅者 */
export const emit = (event: ServerEvent): void => {
  bus.emit("event", event);
};

/** 订阅全部事件，返回取消订阅函数 */
export const subscribe = (cb: (event: ServerEvent) => void): (() => void) => {
  bus.on("event", cb);
  return () => {
    bus.off("event", cb);
  };
};
