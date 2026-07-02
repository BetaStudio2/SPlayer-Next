/**
 * Subsonic 歌词处理
 *
 * 读取文件内嵌歌词元数据（已通过扫描器写入 DB）。
 * 通用 LRC 解析逻辑在 @main/utils/lrc 中。
 */
import { getTrackLyrics } from "@main/database";
import { parseLrc, formatLrcTimestamp, type LrcLine } from "@main/utils/lrc";
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

/** 将歌词数据准备为 Subsonic 协议格式 */
export const prepareSubsonicLyric = (lyric: TrackLyricPayload): PreparedSubsonicLyric => {
  const mainLines = parseLrc(lyric.main);
  if (mainLines.length === 0) {
    return {
      synced: false,
      classicText: lyric.main,
      structuredLines: [],
    };
  }
  const structuredLines: LrcLine[] = [...mainLines];
  return {
    synced: true,
    classicText: structuredLines.map((line) => `${formatLrcTimestamp(line.start)}${line.value}`).join("\n"),
    structuredLines,
  };
};

/**
 * 为指定 Track 读取内嵌歌词（从 DB 的 lyrics 列）
 */
export const fetchLyricForTrack = async (track: Track): Promise<TrackLyricPayload | null> => {
  if (track.id) {
    const embedded = trimLyricText(getTrackLyrics(track.id));
    if (embedded) return { main: embedded };
  }
  return null;
};
