/**
 * window.api.theme mock：背景图上传到服务端缓存
 */

const API_BASE = "/api/config";

/**
 * 创建隐藏的 file input，用户选图后上传到服务端，返回 cache URL
 */
async function uploadBackground(file: File): Promise<string | null> {
  const response = await fetch(`${API_BASE}/background`, {
    method: "POST",
    headers: { "Content-Type": file.type },
    body: file,
  });
  if (!response.ok) {
    console.error("[theme] upload background failed:", response.status);
    return null;
  }
  const data = (await response.json()) as { url?: string; error?: string };
  if (data.error) {
    console.error("[theme] upload background error:", data.error);
    return null;
  }
  return data.url ?? null;
}

export const themeApi = {
  async pickBackgroundImage(): Promise<string | null> {
    // 创建临时 file input
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/jpeg,image/png,image/webp,image/bmp,image/gif";

    return new Promise((resolve) => {
      input.onchange = async () => {
        const file = input.files?.[0];
        if (!file) {
          resolve(null);
          return;
        }
        // 体积校验（30MB）
        if (file.size > 30 * 1024 * 1024) {
          alert("图片体积不能超过 30MB");
          resolve(null);
          return;
        }
        const url = await uploadBackground(file);
        resolve(url);
      };
      input.click();
    });
  },

  async clearBackgroundImages(): Promise<void> {
    try {
      await fetch(`${API_BASE}/background`, { method: "DELETE" });
    } catch (err) {
      console.error("[theme] clear backgrounds failed:", err);
    }
  },
};
