import { ConflictException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

const FIELD_NAME = 'Сверка доставки СДЭК';

export function positiveId(value: unknown): number | undefined {
  if (typeof value !== 'string' && typeof value !== 'number') return undefined;
  if (!/^[1-9]\d*$/.test(String(value))) return undefined;
  const id = Number(value);
  return Number.isSafeInteger(id) ? id : undefined;
}

export function deliveryField(payload: Prisma.JsonValue, configured = process.env.CDEK_DELIVERY_CHECK_FIELD_ID) {
  if (!payload || Array.isArray(payload) || typeof payload !== 'object') {
    throw new ConflictException('Нет сохранённой карточки заказа');
  }
  const configuredId = positiveId(configured);
  if (configured && !configuredId) throw new ConflictException('Некорректный ID поля сверки');
  const fields = payload.customFields ?? [];
  if (!Array.isArray(fields)) throw new ConflictException('Некорректный список полей заказа');
  const rows = fields.filter((f): f is Prisma.JsonObject =>
    !!f && typeof f === 'object' && !Array.isArray(f));
  const matches = rows.filter(f => f.fieldName === FIELD_NAME ||
    (configuredId !== undefined && positiveId(f.fieldId) === configuredId));
  if (!matches.length && configuredId) return { fieldId: configuredId, value: null };
  if (!matches.length) throw new ConflictException('Пустое поле не видно в копии заказа. Укажите ID поля сверки в настройках сайта');
  const row = matches[0];
  const fieldId = positiveId(row.fieldId);
  if (matches.length !== 1 || row.fieldName !== FIELD_NAME || !fieldId ||
      (configuredId !== undefined && configuredId !== fieldId) ||
      rows.some(f => f !== row && positiveId(f.fieldId) === fieldId)) {
    throw new ConflictException('Название и ID поля сверки не совпадают или неоднозначны');
  }
  const values = [row.valueAsText, row.value].filter(value => value != null && value !== '');
  if (values.some(value => typeof value !== 'string' || value !== values[0])) {
    throw new ConflictException('Не удалось однозначно прочитать текст поля сверки');
  }
  return { fieldId, value: (values[0] as string | undefined) ?? null };
}

export function differenceText(kopecks: number): string {
  const amount = BigInt(kopecks);
  const magnitude = amount < 0n ? -amount : amount;
  const sign = amount > 0n ? '+' : amount < 0n ? '-' : '';
  const cents = (magnitude % 100n).toString().padStart(2, '0');
  const marker = magnitude >= 50_000n ? '🔴' : '✓';
  return `${marker} Разница ${sign}${magnitude / 100n},${cents} ₽`;
}
