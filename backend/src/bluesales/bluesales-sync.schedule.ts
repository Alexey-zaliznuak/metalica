export const BLUESALES_SYNC_TIME_ZONE =
  process.env.BLUESALES_SYNC_TIME_ZONE ?? 'Europe/Moscow';

export type BluesalesSyncPhase =
  | 'day'
  | 'night'
  | 'leads-only'
  | 'nightly-orders'
  | 'orders-only'
  | 'morning';

export interface BluesalesSyncSchedule {
  dateKey: string;
  hour: number;
  phase: BluesalesSyncPhase;
  ordersEnabled: boolean;
  leadsEnabled: boolean;
  pauseMultiplier: 1 | 3;
}

interface NightlyOrdersState {
  running: boolean;
  completedDateKey: string | null;
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
 *  - 01:00–02:00 — только лиды, паузы x3;
 *  - с 02:00 до завершения ночного прохода — обычный синк выключен;
 *  - после прохода до 06:00 — только заказы, паузы x3;
 *  - 06:00–09:00 — заказы и лиды, паузы x3;
 *  - 09:00–21:00 — полный режим.
 */
export function getBluesalesSyncSchedule(
  now: Date,
  nightlyOrders: NightlyOrdersState,
  timeZone = BLUESALES_SYNC_TIME_ZONE,
): BluesalesSyncSchedule {
  const { hour } = datePartsInZone(now, timeZone);
  const dateKey = syncDateKey(now, timeZone);
  const slow = hour >= 21 || hour < 9;

  if (nightlyOrders.running) {
    return {
      dateKey,
      hour,
      phase: 'nightly-orders',
      ordersEnabled: false,
      leadsEnabled: false,
      pauseMultiplier: 3,
    };
  }

  if (hour >= 1 && hour < 2) {
    return {
      dateKey,
      hour,
      phase: 'leads-only',
      ordersEnabled: false,
      leadsEnabled: true,
      pauseMultiplier: 3,
    };
  }

  if (hour >= 2 && hour < 6) {
    const nightlyCompleted = nightlyOrders.completedDateKey === dateKey;
    return {
      dateKey,
      hour,
      phase: nightlyCompleted ? 'orders-only' : 'nightly-orders',
      ordersEnabled: nightlyCompleted,
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
