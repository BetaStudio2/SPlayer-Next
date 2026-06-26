/**
 * 桌面专有功能降级 stubs
 * Web 版不可用，方法返回安全默认值或 no-op，避免运行时崩溃
 */
import type { WindowApi, DesktopLyricApi, DynamicIslandApi, TaskbarLyricApi } from "@shared/types/window";
import type { NowPlayingApi } from "@shared/types/nowPlaying";
import type { PluginsApi } from "@shared/types/plugin";
import type { CloudUploadApi } from "@shared/types/cloudUpload";
import type { LastfmApi } from "@shared/types/lastfm";
import type { UpdateApi } from "@shared/types/update";
import type { ExternalApiStatus } from "@shared/types/settings";

const noop = (): void => {};
const noopUnsub = (): (() => void) => () => {};
const empty = async (): Promise<void> => {};
const emptyArr = async <T>(): Promise<T[]> => [];
const emptyBool = async (): Promise<boolean> => false;
const emptyNull = async <T>(): Promise<T | null> => null;

export const windowApi = {
  minimize: noop,
  toggleMaximize: noop,
  toggleFullscreen: (): void => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void document.documentElement.requestFullscreen?.();
  },
  hide: noop,
  quit: noop,
  async isMaximized(): Promise<boolean> {
    return false;
  },
  async isFullscreen(): Promise<boolean> {
    return !!document.fullscreenElement;
  },
  onMaximizeChange: noopUnsub,
  onFullscreenChange: noopUnsub,
  toggleDesktopLyric: empty,
  toggleDynamicIsland: empty,
  toggleTaskbarLyric: empty,
  onDesktopLyricVisibilityChange: noopUnsub,
  onDynamicIslandVisibilityChange: noopUnsub,
  onTaskbarLyricVisibilityChange: noopUnsub,
  isDesktopLyricOpen: emptyBool,
  isDynamicIslandOpen: emptyBool,
  isTaskbarLyricOpen: emptyBool,
} as unknown as WindowApi;

export const desktopLyricApi = {
  onConfigChange: noopUnsub,
} as unknown as DesktopLyricApi;

export const dynamicIslandApi = {
  onConfigChange: noopUnsub,
} as unknown as DynamicIslandApi;

export const taskbarLyricApi = {} as unknown as TaskbarLyricApi;

export const nowPlayingApi = {
  update: noop,
  setLyricOffset: noop,
  onLyricOffsetChange: noopUnsub,
  async requestSnapshot(): Promise<{ lyricOffsetMs: number }> {
    return { lyricOffsetMs: 0 };
  },
} as unknown as NowPlayingApi;

export const pluginsApi = {
  list: emptyArr,
  onStatus: noopUnsub,
  pickAndInstall: emptyNull,
  installFromUrl: emptyNull,
  uninstall: empty,
  setEnabled: empty,
  resolveUrl: emptyNull,
} as unknown as PluginsApi;

export const cloudApi = {
  onUploadProgress: noopUnsub,
  uploadSong: emptyNull,
  pickSongs: emptyArr,
} as unknown as CloudUploadApi;

export const lastfmApi = {
  love: empty,
  cancelConnect: empty,
  disconnect: empty,
  async getStatus(): Promise<{ connected: boolean; sessionName?: string }> {
    return { connected: false };
  },
  async connect(): Promise<{ ok: boolean; error?: string }> {
    return { ok: false, error: "Web 版不支持 Last.fm 授权" };
  },
} as unknown as LastfmApi;

const emptyStatus = async (): Promise<ExternalApiStatus> => ({
  listening: false,
  allowLan: false,
  host: null,
  port: null,
  error: null,
});

export const externalApi = {
  restart: emptyStatus,
  getStatus: emptyStatus,
};

export const updateApi = {
  onEvent: noopUnsub,
  check: empty,
  download: empty,
  install: empty,
  openDownloadPage: (): void => {
    window.open("https://github.com/SPlayer-Dev/SPlayer-Next/releases", "_blank");
  },
} as unknown as UpdateApi;
