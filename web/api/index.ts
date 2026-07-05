/**
 * Web 版 window.api 注入入口
 *
 * 严格按 electron/preload/index.d.ts 的接口签名实现 mock，
 * 在 src 代码执行前注入，使原 renderer 零改动运行于浏览器。
 */
import { playerApi } from "./player";
import { apisApi } from "./apis";
import { configApi } from "./config";
import { lyricsApi } from "./lyrics";
import { libraryApi } from "./library";
import { systemApi } from "./system";
import { hotkeyApi } from "./hotkey";
import { statsApi } from "./stats";
import { cacheApi } from "./cache";
import { themeApi } from "./theme";
import { downloadApi } from "./download";
import { streamingApi } from "./streaming";
import { commentsApi } from "./comments";
import {
  windowApi,
  desktopLyricApi,
  dynamicIslandApi,
  taskbarLyricApi,
  nowPlayingApi,
  pluginsApi,
  cloudApi,
  lastfmApi,
  externalApi,
  updateApi,
} from "./stubs";

/** 组装完整的 window.api 对象 */
const buildApi = () => ({
  config: configApi,
  player: playerApi,
  system: systemApi,
  library: libraryApi,
  window: windowApi,
  desktopLyric: desktopLyricApi,
  dynamicIsland: dynamicIslandApi,
  taskbarLyric: taskbarLyricApi,
  nowPlaying: nowPlayingApi,
  plugins: pluginsApi,
  apis: apisApi,
  cloud: cloudApi,
  lyrics: lyricsApi,
  download: downloadApi,
  comments: commentsApi,
  theme: themeApi,
  cache: cacheApi,
  stats: statsApi,
  hotkey: hotkeyApi,
  streaming: streamingApi,
  lastfm: lastfmApi,
  externalApi,
  update: updateApi,
});

/** 注入 window.api 到全局，须在 src 代码执行前调用 */
export const injectWebApi = (): void => {
  const api = buildApi();
  Object.defineProperty(window, "api", {
    value: api,
    writable: false,
    configurable: false,
  });
  Object.defineProperty(window, "electron", {
    value: {
      process: { platform: "web", versions: {} },
      ipcRenderer: { send: () => {}, invoke: async () => undefined, on: () => () => {} },
    },
    writable: false,
    configurable: false,
  });
};

export type WebApi = ReturnType<typeof buildApi>;
