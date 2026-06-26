/**
 * Polyfill crypto.randomUUID for non-secure context
 * 局域网 http://IP 访问时 crypto.randomUUID 不可用（仅 secure context 可用），
 * src 中多处依赖（useDownload/streaming/session 等），此处统一补齐。
 */
if (typeof crypto !== "undefined" && typeof crypto.randomUUID !== "function") {
  Object.defineProperty(crypto, "randomUUID", {
    value: (): string => {
      const b = crypto.getRandomValues(new Uint8Array(16));
      b[6] = (b[6] & 0x0f) | 0x40; // version 4
      b[8] = (b[8] & 0x3f) | 0x80; // variant 10
      const h = [...b].map((x) => x.toString(16).padStart(2, "0"));
      return `${h.slice(0, 4).join("")}-${h.slice(4, 6).join("")}-${h.slice(6, 8).join("")}-${h.slice(8, 10).join("")}-${h.slice(10, 16).join("")}`;
    },
    configurable: true,
    writable: true,
  });
}

import "virtual:uno.css";
import "@/styles/global.css";

import { injectWebApi } from "./api";

// 1. 先注入 mock 层：在 src 代码执行之前，window.api 就已可用
injectWebApi();

import piniaPersistedstate from "pinia-plugin-persistedstate";
import App from "@/App.vue";
import router from "@/router";
import i18n from "@/i18n";

import { useThemeStore } from "@/stores/theme";
import { useSettingsStore } from "@/stores/settings";
import { useHotkeyStore } from "@/stores/hotkey";
import { initPlayer } from "@/core/player";
import { installHotkeyManager } from "@/core/hotkey/manager";
import { vRipple } from "@/directives/ripple";

const pinia = createPinia();
pinia.use(piniaPersistedstate);

const app = createApp(App);
app.directive("ripple", vRipple);
app.use(pinia);
app.use(router);
app.use(i18n);

// 初始化主题
useThemeStore().init();

// 同步语言设置（Web 版无需同步 locale 到主进程，仅切 i18n）
watch(
  () => useSettingsStore().locale,
  (v) => {
    i18n.global.locale.value = v;
  },
  { immediate: true },
);

/** 笔画动画结束 */
const SPLASH_ANIM_MS = 2050;

// 初始化程序
router.isReady().then(() => {
  // 挂载应用
  app.mount("#app");
  // 笔画播完即淡出
  const remaining = Math.max(0, SPLASH_ANIM_MS - performance.now());
  setTimeout(() => {
    const loading = document.getElementById("app-loading");
    if (loading) {
      loading.classList.add("hidden");
      loading.addEventListener("transitionend", () => loading.remove(), { once: true });
    }
  }, remaining);
  // 初始化播放器
  initPlayer().catch(console.error);
  // 初始化快捷键
  useHotkeyStore()
    .init()
    .then(installHotkeyManager)
    .catch((err) => console.error("[hotkey] init failed", err));
});
