// Названия статусов заказа BlueSales, по которым замеряется время работы над эскизом.
// Сравнение регистронезависимое и без учёта окружающих пробелов.
export const SKETCH_START_STATUS = 'Готовим эскиз';
export const SKETCH_READY_STATUS = 'Эскиз готов';

function normalize(value: string | null | undefined): string {
  return (value ?? '').trim().toLowerCase();
}

export function isSketchStartStatus(statusName: string | null | undefined): boolean {
  return normalize(statusName) === normalize(SKETCH_START_STATUS);
}

export function isSketchReadyStatus(statusName: string | null | undefined): boolean {
  return normalize(statusName) === normalize(SKETCH_READY_STATUS);
}

/** true, если статус относится к циклу эскиза (нужно только тогда трогать метки). */
export function isSketchTrackedStatus(statusName: string | null | undefined): boolean {
  return isSketchStartStatus(statusName) || isSketchReadyStatus(statusName);
}

export interface SketchTimestamps {
  sketchStartedAt: Date | null;
  sketchReadyAt: Date | null;
}

/**
 * Возвращает частичный апдейт меток эскиза для заказа при переходе в новый статус.
 *
 * Правила (метки одноразовые):
 *  - при входе в «Готовим эскиз» ставим sketchStartedAt, если он ещё не проставлен;
 *  - при входе в «Эскиз готов» ставим sketchReadyAt, если он ещё не проставлен.
 *
 * Возвращает пустой объект, если ничего менять не нужно.
 */
export function computeSketchTimestampUpdate(
  newStatusName: string | null | undefined,
  current: SketchTimestamps,
  now: Date = new Date(),
): Partial<SketchTimestamps> {
  const update: Partial<SketchTimestamps> = {};
  if (isSketchStartStatus(newStatusName) && !current.sketchStartedAt) {
    update.sketchStartedAt = now;
  }
  if (isSketchReadyStatus(newStatusName) && !current.sketchReadyAt) {
    update.sketchReadyAt = now;
  }
  return update;
}
