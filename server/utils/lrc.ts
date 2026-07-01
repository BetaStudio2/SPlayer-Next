/**
 * LRC 歌词解析工具
 *
 * 纯函数，无业务依赖。解析 LRC 文本为带时间戳的结构化行，
 * 支持翻译/罗马音的对齐。
 */

export interface LrcLine {
  start: number;
  value: string;
}

/** LRC 时间标签 → 毫秒 */
export const lrcTimeToMs = (hh: string | undefined, mm: string, ss: string, xx: string): number => {
  const hours = hh ? parseInt(hh, 10) || 0 : 0;
  const minutes = parseInt(mm, 10) || 0;
  const seconds = parseInt(ss, 10) || 0;
  const frac = xx ? parseFloat(`0.${xx}`) * 1000 : 0;
  return hours * 3_600_000 + minutes * 60_000 + seconds * 1000 + Math.round(frac);
};

/** 毫秒 → [mm:ss.xx] */
export const formatLrcTimestamp = (ms: number): string => {
  const safe = Math.max(0, ms);
  const mm = Math.floor(safe / 60000);
  const ss = Math.floor((safe % 60000) / 1000);
  const xx = Math.floor((safe % 1000) / 10);
  return `[${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}.${String(xx).padStart(2, "0")}]`;
};

/** 解析 LRC 文本为带时间戳的行（过滤元数据标签如 [ti:...]） */
export const parseLrc = (text: string): LrcLine[] => {
  const lines: LrcLine[] = [];
  const re = /\[(?:(\d{1,2}):)?(\d{1,2}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;
  for (const raw of text.split(/\r?\n/)) {
    re.lastIndex = 0;
    const stamps: number[] = [];
    let m: RegExpExecArray | null;
    while ((m = re.exec(raw)) !== null) stamps.push(lrcTimeToMs(m[1], m[2], m[3], m[4] ?? ""));
    if (stamps.length === 0) continue;
    const value = raw.replace(re, "").trim();
    for (const start of stamps) lines.push({ start, value });
  }
  return lines.sort((a, b) => a.start - b.start);
};

const LRC_ALIGN_TOLERANCE_MS = 300;

/**
 * 将辅助行（翻译/罗马音）按时间戳对齐到主行列表
 * @returns 每行对应的辅助文本（无匹配则为 null）
 */
export const alignAuxiliaryLines = (mainLines: LrcLine[], extraLines: LrcLine[]): (string | null)[] => {
  const aligned = Array<string | null>(mainLines.length).fill(null);
  if (mainLines.length === 0 || extraLines.length === 0) return aligned;
  let cursor = 0;
  for (let i = 0; i < mainLines.length; i++) {
    const mainStart = mainLines[i].start;
    while (cursor < extraLines.length && extraLines[cursor].start < mainStart - LRC_ALIGN_TOLERANCE_MS) {
      cursor++;
    }
    let bestIndex = -1;
    let bestDiff = LRC_ALIGN_TOLERANCE_MS + 1;
    for (let j = cursor; j < extraLines.length; j++) {
      const diff = extraLines[j].start - mainStart;
      if (diff > LRC_ALIGN_TOLERANCE_MS) break;
      const absDiff = Math.abs(diff);
      if (absDiff < bestDiff) {
        bestDiff = absDiff;
        bestIndex = j;
      }
    }
    if (bestIndex >= 0) {
      aligned[i] = extraLines[bestIndex].value;
      cursor = bestIndex + 1;
    }
  }
  return aligned;
};
