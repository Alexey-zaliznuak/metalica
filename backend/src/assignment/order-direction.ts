import { OrderDirection } from '@prisma/client';

/**
 * При нескольких стилях на одном заказе берём круг с высшим приоритетом.
 * «Фотопечать» и «Ретушь» — один круг.
 */
const DIRECTION_PRIORITY: OrderDirection[] = [
  OrderDirection.DIGITAL,
  OrderDirection.NEURO_ART,
  OrderDirection.PHOTO_RETOUCH,
];

/**
 * Определяет направление заказа по тегам клиента в BlueSales.
 *
 * Неизвестные теги игнорируются. Если стилей несколько, выбирается один
 * по приоритету: Диджитал → Нейро → Ретушь/Фотопечать. Без подходящих
 * тегов направление не определяется — назначение вручную.
 */
export function resolveOrderDirection(tagNames: string[]): OrderDirection | null {
  const found = new Set<OrderDirection>();
  for (const tagName of tagNames) {
    switch (tagName.trim().toLocaleLowerCase('ru-RU')) {
      case 'фотопечать':
      case 'ретушь':
        found.add(OrderDirection.PHOTO_RETOUCH);
        break;
      case 'нейро':
        found.add(OrderDirection.NEURO_ART);
        break;
      case 'диджитал':
        found.add(OrderDirection.DIGITAL);
        break;
      default:
        break;
    }
  }
  return DIRECTION_PRIORITY.find((direction) => found.has(direction)) ?? null;
}
