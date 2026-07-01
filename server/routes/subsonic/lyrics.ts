/**
 * Subsonic 歌词处理
 *
 * 为 Track 拉取歌词并解析为 Subsonic 协议的结构化格式。
 * 优先读音乐文件内嵌歌词，回退到 Netease 在线匹配。
 *
 * 通用 LRC 解析逻辑在 @main/utils/lrc 中。
 */
import * as neteaseLyric from "@main/apis/common/lyric/netease";
import { getTrackLyrics } from "@main/database";
import { serverLog } from "@main/utils/logger";
import { parseLrc, formatLrcTimestamp, alignAuxiliaryLines, type LrcLine } from "@main/utils/lrc";
import type { Track } from "@shared/types/player";

export type { LrcLine };

export interface TrackLyricPayload {
  main: string;
  translation?: string;
  romaji?: string;
}

export interface PreparedSubsonicLyric {
  synced: boolean;
  classicText: string;
  structuredLines: LrcLine[];
}

const trimLyricText = (text?: string | null): string | undefined => {
  const trimmed = text?.trim();
  return trimmed ? trimmed : undefined;
};

/** 将歌词数据（主歌词 + 翻译 + 罗马音）准备为 Subsonic 协议格式 */
export const prepareSubsonicLyric = (lyric: TrackLyricPayload): PreparedSubsonicLyric => {
  const mainLines = parseLrc(lyric.main);
  if (mainLines.length === 0) {
    return {
      synced: false,
      classicText: lyric.main,
      structuredLines: [],
    };
  }
  const translationLines = lyric.translation ? parseLrc(lyric.translation) : [];
  const romajiLines = lyric.romaji ? parseLrc(lyric.romaji) : [];
  const alignedTranslation = alignAuxiliaryLines(mainLines, translationLines);
  const alignedRomaji = alignAuxiliaryLines(mainLines, romajiLines);
  const structuredLines: LrcLine[] = [];
  for (let i = 0; i < mainLines.length; i++) {
    const main = mainLines[i];
    const translation = alignedTranslation[i];
    const romaji = alignedRomaji[i];
    structuredLines.push(main);
    if (translation) structuredLines.push({ start: main.start, value: translation });
    if (romaji) structuredLines.push({ start: main.start, value: romaji });
  }
  return {
    synced: true,
    classicText: structuredLines.map((line) => `${formatLrcTimestamp(line.start)}${line.value}`).join("\n"),
    structuredLines,
  };
};

/**
 * 为指定 Track 拉取歌词：
 * 1) 优先读音乐文件内嵌歌词元数据
 * 2) 回退到 netease 在线匹配
 */
export const fetchLyricForTrack = async (track: Track): Promise<TrackLyricPayload | null> => {
  // 1) 内嵌歌词
  if (track.id) {
    const embedded = trimLyricText(getTrackLyrics(track.id));
    if (embedded) return { main: embedded };
  }
  // 2) 在线匹配
  try {
    const matched = await neteaseLyric.getByQuery(track);
    if (matched) {
      const main =
        matched.format === "lrc"
          ? trimLyricText(matched.content)
          : trimLyricText(await neteaseLyric.getLrcByQuery(track));
      if (main) {
        return {
          main,
          translation: trimLyricText(matched.translation),
          romaji: trimLyricText(matched.romaji),
        };
      }
    }
  } catch (err) {
    serverLog.warn(`[subsonic] fetchLyricForTrack(${track.title}) netease failed:`, err);
  }
  try {
    const main = trimLyricText(await neteaseLyric.getLrcByQuery(track));
    if (main) return { main };
  } catch (err) {
    serverLog.warn(`[subsonic] fetchLyricForTrack(${track.title}) netease lrc fallback failed:`, err);
  }
  return null;
};
