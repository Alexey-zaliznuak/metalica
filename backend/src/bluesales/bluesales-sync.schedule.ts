export const BLUESALES_SYNC_TIME_ZONE =
  process.env.BLUESALES_SYNC_TIME_ZONE ?? 'Europe/Moscow';

export type BluesalesSyncPhase =
  | 'day'
  | 'night'
  | 'paused'
  | 'morning';

export interface BluesalesSyncSchedule {
  dateKey: string;
  hour: number;
  phase: BluesalesSyncPhase;
  ordersEnabled: boolean;
  leadsEnabled: boolean;
  pauseMultiplier: 1 | 3;
}

export interface ZonedDateParts {
  year: number;
  month: number;
  day: number;
  hour: number;
}

/** Возвращает календарные части даты в часовом поясе расписания синка. */
export function datePartsInZone(
  now: Date,
  timeZone = BLUESALES_SYNC_TIME_ZONE,
): ZonedDateParts {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now);
  const read = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((part) => part.type === type)?.value);

  return {
    year: read('year'),
    month: read('month'),
    day: read('day'),
    hour: read('hour'),
  };
}

export function syncDateKey(
  now: Date,
  timeZone = BLUESALES_SYNC_TIME_ZONE,
): string {
  const { year, month, day } = datePartsInZone(now, timeZone);
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/**
 * Расписание фонового синка BlueSales:
 *  - 21:00–01:00 — заказы и лиды, паузы x3;
 *  - 01:00–06:00 — все синки выключены;
 *  - 06:00–09:00 — заказы и лиды, паузы x3;
 *  - 09:00–21:00 — полный режим.
 */
export function getBluesalesSyncSchedule(
  now = new Date(),
  timeZone = BLUESALES_SYNC_TIME_ZONE,
): BluesalesSyncSchedule {
  const { hour } = datePartsInZone(now, timeZone);
  const dateKey = syncDateKey(now, timeZone);
  const slow = hour >= 21 || hour < 9;

  if (hour >= 1 && hour < 6) {
    return {
      dateKey,
      hour,
      phase: 'paused',
      ordersEnabled: false,
      leadsEnabled: false,
      pauseMultiplier: 3,
    };
  }

  return {
    dateKey,
    hour,
    phase: hour >= 6 && hour < 9 ? 'morning' : slow ? 'night' : 'day',
    ordersEnabled: true,
    leadsEnabled: true,
    pauseMultiplier: slow ? 3 : 1,
  };
}
