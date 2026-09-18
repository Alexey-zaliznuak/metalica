export const USAGE_TIME_ZONE = 'Europe/Moscow';
export const HOUR_MS = 3_600_000;
export const DAY_MS = 24 * HOUR_MS;
export const USAGE_TARGET_MS = 3 * HOUR_MS;
// 01:00 МСК = 22:00 UTC предыдущего дня. МСК использует UTC+3.
export function usagePeriodStart(now: Date): Date {
  return new Date(Math.floor((now.getTime() + 2 * HOUR_MS) / DAY_MS) * DAY_MS - 2 * HOUR_MS);
}

export function usageDateKey(start: Date): string {
  return new Date(start.getTime() + 3 * HOUR_MS).toISOString().slice(0, 10);
}

function syncWeight(at: number): number {
  const hour = new Date(at + 3 * HOUR_MS).getUTCHours();
  if (hour >= 1 && hour < 6) return 0;
  return hour < 9 ? 1 / 3 : 1;
}

/** Эквивалент времени в дневном режиме, с учётом паузы и замедления x3. */
export function weightedSyncTime(from: number, to: number): number {
  let total = 0;
  for (let cursor = from; cursor < to;) {
    const next = Math.min(to, (Math.floor(cursor / HOUR_MS) + 1) * HOUR_MS);
    total += (next - cursor) * syncWeight(cursor);
    cursor = next;
  }
  return total;
}

export function usageForecast(input: {
  now: Date; periodStart: Date; totalMs: number; recentMs: number;
  recentCount: number; observedFrom: Date;
}) {
  const { now, periodStart, totalMs, recentMs, recentCount, observedFrom } = input;
  const end = periodStart.getTime() + DAY_MS;
  const windowStart = Math.max(periodStart.getTime(), now.getTime() - HOUR_MS, observedFrom.getTime());
  const weightedMs = weightedSyncTime(windowStart, now.getTime());
  const base = { windowStart: new Date(windowStart), windowEnd: now, sampleCount: recentCount };
  if (now.getTime() >= end) return { ...base, status: 'closed', projectedTotalMs: null, reachesAt: null, points: [] };
  if (totalMs >= USAGE_TARGET_MS) return { ...base, status: 'reached', projectedTotalMs: null, reachesAt: null, points: [] };
  // Минимум 15 минут наблюдения вне ночной паузы и пять успешных запросов.
  const activeMs = (() => {
    let result = 0;
    for (let cursor = windowStart; cursor < now.getTime();) {
      const next = Math.min(now.getTime(), (Math.floor(cursor / HOUR_MS) + 1) * HOUR_MS);
      if (syncWeight(cursor) > 0) result += next - cursor;
      cursor = next;
    }
    return result;
  })();
  if (recentCount < 5 || activeMs < 15 * 60_000 || weightedMs <= 0) {
    return { ...base, status: 'insufficient-data', projectedTotalMs: null, reachesAt: null, points: [] };
  }
  const rate = recentMs / weightedMs;
  let projected = totalMs;
  let reachesAt: Date | null = null;
  const points = [{ at: now, totalMs }];
  for (let cursor = now.getTime(); cursor < end;) {
    const next = Math.min(end, (Math.floor(cursor / HOUR_MS) + 1) * HOUR_MS);
    const segmentRate = rate * syncWeight(cursor);
    const added = segmentRate * (next - cursor);
    if (!reachesAt && segmentRate > 0 && projected + added >= USAGE_TARGET_MS) {
      reachesAt = new Date(cursor + (USAGE_TARGET_MS - projected) / segmentRate);
    }
    projected += added;
    points.push({ at: new Date(next), totalMs: Math.round(projected) });
    cursor = next;
  }
  return { ...base, status: reachesAt ? 'will-reach' : 'below-target', projectedTotalMs: Math.round(projected), reachesAt, points };
}
