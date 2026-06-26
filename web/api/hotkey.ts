/**
 * window.api.hotkey mock：浏览器键盘事件监听
 * 仅支持 inApp 作用域；global 作用域降级为不可用
 */
import type {
  HotkeyApi,
  HotkeyConfig,
  HotkeyActionId,
  HotkeyBinding,
  HotkeyConflict,
} from "@shared/types/hotkey";

const STORAGE_KEY = "splayer:hotkey-config";

const DEFAULT_CONFIG: HotkeyConfig = {
  globalEnabled: false,
  bindings: {
    "player.togglePlay": { inApp: "Space", global: null },
    "player.next": { inApp: "CommandOrControl+Right", global: null },
    "player.prev": { inApp: "CommandOrControl+Left", global: null },
    "player.seekForward": { inApp: "Shift+Right", global: null },
    "player.seekBack": { inApp: "Shift+Left", global: null },
    "player.volumeUp": { inApp: "ArrowUp", global: null },
    "player.volumeDown": { inApp: "ArrowDown", global: null },
    "player.cycleRepeat": { inApp: "CommandOrControl+R", global: null },
    "player.toggleShuffle": { inApp: "CommandOrControl+S", global: null },
    "window.toggleDesktopLyric": { inApp: null, global: null },
    "window.toggleDynamicIsland": { inApp: null, global: null },
    "window.toggleTaskbarLyric": { inApp: null, global: null },
    "view.openPlayer": { inApp: null, global: null },
    "view.closePlayer": { inApp: null, global: null },
    "view.togglePlaylist": { inApp: null, global: null },
    "view.openSearch": { inApp: "CommandOrControl+F", global: null },
  },
};

const loadConfig = (): HotkeyConfig => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return { ...DEFAULT_CONFIG, ...JSON.parse(raw) };
  } catch {}
  return DEFAULT_CONFIG;
};

const saveConfig = (cfg: HotkeyConfig): void => {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(cfg));
};

/** 把 accelerator 解析为可匹配的 keydown 字段 */
const parseAccel = (accel: string): { ctrl: boolean; alt: boolean; shift: boolean; meta: boolean; key: string } => {
  const parts = accel.split("+").map((p) => p.trim());
  let ctrl = false;
  let alt = false;
  let shift = false;
  let meta = false;
  let key = "";
  for (const p of parts) {
    switch (p.toLowerCase()) {
      case "ctrl":
      case "control":
        ctrl = true;
        break;
      case "cmd":
      case "command":
      case "commandorcontrol":
        ctrl = true;
        break;
      case "alt":
        alt = true;
        break;
      case "shift":
        shift = true;
        break;
      case "meta":
      case "super":
        meta = true;
        break;
      default:
        key = p.toLowerCase();
    }
  }
  return { ctrl, alt, shift, meta, key };
};

const matchKey = (accel: string, e: KeyboardEvent): boolean => {
  const parsed = parseAccel(accel);
  const key = e.key.toLowerCase();
  // Space → " "
  const normalizedKey = parsed.key === "space" ? " " : parsed.key;
  if (key !== normalizedKey) return false;
  if (parsed.ctrl !== (e.ctrlKey || e.metaKey)) return false;
  if (parsed.alt !== e.altKey) return false;
  if (parsed.shift !== e.shiftKey) return false;
  return true;
};

let config = loadConfig();
const triggers = new Set<(id: HotkeyActionId) => void>();

// 全局键盘监听
document.addEventListener("keydown", (e) => {
  // 输入框内不触发（除非带修饰键）
  const target = e.target as HTMLElement;
  const isInput =
    target.tagName === "INPUT" ||
    target.tagName === "TEXTAREA" ||
    target.isContentEditable;
  if (isInput && !e.ctrlKey && !e.metaKey && !e.altKey) return;

  for (const [id, binding] of Object.entries(config.bindings)) {
    const accel = binding.inApp;
    if (!accel) continue;
    if (matchKey(accel, e)) {
      e.preventDefault();
      triggers.forEach((cb) => cb(id as HotkeyActionId));
      break;
    }
  }
});

export const hotkeyApi: HotkeyApi = {
  async getAll(): Promise<HotkeyConfig> {
    return config;
  },

  async set(id: HotkeyActionId, binding: HotkeyBinding): Promise<HotkeyConfig> {
    config = { ...config, bindings: { ...config.bindings, [id]: binding } };
    saveConfig(config);
    return config;
  },

  async reset(id?: HotkeyActionId): Promise<HotkeyConfig> {
    if (id) {
      config = {
        ...config,
        bindings: { ...config.bindings, [id]: DEFAULT_CONFIG.bindings[id] },
      };
    } else {
      config = { ...DEFAULT_CONFIG };
    }
    saveConfig(config);
    return config;
  },

  async setGlobalEnabled(enabled: boolean): Promise<HotkeyConfig> {
    config = { ...config, globalEnabled: enabled };
    saveConfig(config);
    return config;
  },

  async probe(): Promise<boolean> {
    // Web 版无法注册全局快捷键，global 总是 false
    return false;
  },

  async getConflicts(): Promise<HotkeyConflict[]> {
    return [];
  },

  onTrigger(callback: (id: HotkeyActionId) => void): () => void {
    triggers.add(callback);
    return () => triggers.delete(callback);
  },

  onConflicts(): () => void {
    return () => {};
  },
};
