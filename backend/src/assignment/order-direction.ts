import { OrderDirection } from '@prisma/client';

/**
 * Определяет направление заказа по тегам клиента в BlueSales.
 *
 * «Фотопечать» и «Ретушь» входят в один круг. Неизвестные теги игнорируются.
 * Распределяем заказ только при единственном найденном направлении; отсутствие
 * подходящих тегов или конфликт нескольких направлений означает ручное назначение.
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
  return found.size === 1 ? [...found][0] : null;
}
