/**
 * window.api.stats mock：本地 localStorage 统计
 * 保留收听体验，多端不互通（P2 阶段足够）
 */
import type {
  StatsApi,
  PlayEventInput,
  FavoriteEventInput,
  PlayStatsSummary,
  TopTrack,
} from "@shared/types/stats";
import type { Track } from "@shared/types/player";

interface StoredPlay {
  trackId: string;
  track: Track;
  startedAt: number;
  listenedMs: number;
}

const PLAYS_KEY = "splayer:stats:plays";
const FAV_KEY = "splayer:stats:favorites";

const loadPlays = (): StoredPlay[] => {
  try {
    return JSON.parse(localStorage.getItem(PLAYS_KEY) ?? "[]") as StoredPlay[];
  } catch {
    return [];
  }
};

const savePlays = (plays: StoredPlay[]): void => {
  // 仅保留最近 1000 条，避免 localStorage 溢出
  localStorage.setItem(PLAYS_KEY, JSON.stringify(plays.slice(-1000)));
};

const startOfDay = (ts: number): number => {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};

export const statsApi: StatsApi = {
  recordPlay(event: PlayEventInput): void {
    const plays = loadPlays();
    plays.push({
      trackId: event.track.id,
      track: event.track,
      startedAt: event.startedAt,
      listenedMs: event.listenedMs,
    });
    savePlays(plays);
  },

  recordFavorite(event: FavoriteEventInput): void {
    try {
      const list = JSON.parse(localStorage.getItem(FAV_KEY) ?? "[]") as {
        track: Track;
        action: string;
        ts: number;
      }[];
      list.push({ track: event.track, action: event.action, ts: Date.now() });
      localStorage.setItem(FAV_KEY, JSON.stringify(list.slice(-1000)));
    } catch {}
  },

  async getStatsSummary(): Promise<PlayStatsSummary> {
    const plays = loadPlays();
    const now = Date.now();
    const todayStart = startOfDay(now);
    const dayMs = 86400000;
    const weekStart = todayStart - ((new Date(now).getDay() || 7) - 1) * dayMs;
    const lastWeekStart = weekStart - 7 * dayMs;

    const todayListenedMs = plays
      .filter((p) => p.startedAt >= todayStart)
      .reduce((s, p) => s + p.listenedMs, 0);
    const weekListenedMs = plays
      .filter((p) => p.startedAt >= weekStart)
      .reduce((s, p) => s + p.listenedMs, 0);
    const lastWeekListenedMs = plays
      .filter((p) => p.startedAt >= lastWeekStart && p.startedAt < weekStart)
      .reduce((s, p) => s + p.listenedMs, 0);
    const totalListenedMs = plays.reduce((s, p) => s + p.listenedMs, 0);

    // 连续天数
    const days = new Set(plays.map((p) => startOfDay(p.startedAt)));
    let streakDays = 0;
    for (let i = 0; i < 365; i++) {
      const day = startOfDay(now - i * dayMs);
      if (days.has(day)) streakDays++;
      else if (i > 0) break;
    }

    return {
      todayListenedMs,
      weekListenedMs,
      lastWeekListenedMs,
      totalListenedMs,
      weekPlayCount: plays.filter((p) => p.startedAt >= weekStart).length,
      totalPlayCount: plays.length,
      weekFavoriteAdds: 0,
      streakDays,
    };
  },

  async getTopTracks(limit: number): Promise<TopTrack[]> {
    const plays = loadPlays();
    const counts = new Map<string, { track: Track; count: number }>();
    for (const p of plays) {
      const existing = counts.get(p.trackId);
      if (existing) existing.count++;
      else counts.set(p.trackId, { track: p.track, count: 1 });
    }
    return Array.from(counts.values())
      .sort((a, b) => b.count - a.count)
      .slice(0, limit)
      .map((c) => ({ track: c.track, playCount: c.count }));
  },
};
