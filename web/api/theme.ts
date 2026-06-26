/**
 * window.api.theme mock：背景图改用 URL
 */
const STORAGE_KEY = "splayer:theme:backgrounds";

const load = (): string[] => {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]") as string[];
  } catch {
    return [];
  }
};

export const themeApi = {
  async pickBackgroundImage(): Promise<string | null> {
    const url = window.prompt("输入背景图片 URL：");
    if (!url) return null;
    const list = load();
    list.push(url);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
    return url;
  },

  async clearBackgroundImages(): Promise<void> {
    localStorage.removeItem(STORAGE_KEY);
  },
};
