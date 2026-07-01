/**
 * Subsonic XML 序列化
 *
 * 简易 XML 序列化，兼容老客户端（f=xml 或缺省时使用）。
 * 将 subsonic-response 对象序列化为 XML 字符串。
 */

/** 复数 → 单数映射 */
const singularMap: Record<string, string> = {
  artists: "artist",
  albums: "album",
  songs: "song",
  entries: "entry",
  playlists: "playlist",
  shares: "share",
  genres: "genre",
  indexes: "index",
  children: "child",
  musicFolders: "musicFolder",
  similarSongs: "similarSong",
  similarSongs2: "similarSong",
  searchResult2: "searchResult2",
  searchResult3: "searchResult3",
  artistsRoot: "artists",
  versions: "versions",
};

const singularOf = (key: string): string => singularMap[key] ?? key.replace(/s$/, "");

const escapeXml = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const isPrimitive = (v: unknown): v is string | number | boolean =>
  typeof v === "string" || typeof v === "number" || typeof v === "boolean";

/** 对象 → XML 元素 */
const objToXml = (name: string, obj: unknown, indent = ""): string => {
  if (obj == null) return "";
  if (isPrimitive(obj)) return `${indent}<${name}>${escapeXml(String(obj))}</${name}>\n`;
  if (Array.isArray(obj)) {
    const child = singularOf(name);
    return obj.map((item) => objToXml(child, item, indent)).join("");
  }
  if (typeof obj === "object") {
    const o = obj as Record<string, unknown>;
    // Lyrics / line / cue 等包含正文的元素，value 走 chardata 而非 XML attribute
    if (
      typeof o.value === "string" &&
      (name === "lyrics" || name === "line" || name === "cue")
    ) {
      const attrs: string[] = [];
      const children: string[] = [];
      for (const [k, v] of Object.entries(o)) {
        if (v == null || k === "value") continue;
        if (isPrimitive(v)) attrs.push(`${k}="${escapeXml(String(v))}"`);
        else children.push(objToXml(k, v, indent + "  "));
      }
      const attrStr = attrs.length ? " " + attrs.join(" ") : "";
      const text = escapeXml(o.value);
      if (children.length === 0) return `${indent}<${name}${attrStr}>${text}</${name}>\n`;
      return `${indent}<${name}${attrStr}>${text}\n${children.join("")}${indent}</${name}>\n`;
    }
    const attrs: string[] = [];
    const children: string[] = [];
    for (const [k, v] of Object.entries(o)) {
      if (v == null) continue;
      if (isPrimitive(v)) attrs.push(`${k}="${escapeXml(String(v))}"`);
      else children.push(objToXml(k, v, indent + "  "));
    }
    const attrStr = attrs.length ? " " + attrs.join(" ") : "";
    if (children.length === 0) return `${indent}<${name}${attrStr}/>\n`;
    return `${indent}<${name}${attrStr}>\n${children.join("")}${indent}</${name}>\n`;
  }
  return "";
};

/** 把 subsonic-response 主体序列化为 XML */
export const toXml = (body: Record<string, unknown>): string => {
  const root = body["subsonic-response"] as Record<string, unknown>;
  return `<?xml version="1.0" encoding="UTF-8"?>\n${objToXml("subsonic-response", root)}`;
};
