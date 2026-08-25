import { OrderDirection } from '@prisma/client';
import { GoodsPosition } from '../goods/goods-payload';

/**
 * Определяет направление заказа по его товарам.
 *
 * Влияющими считаются только те товары, которым администратор задал направление
 * в справочнике (остальные — допы: упаковка, срочность, крепления). Правило
 * строгое: распределяем заказ только при единственном найденном направлении.
 * Ноль влияющих товаров или конфликт нескольких направлений означают, что
 * художника назначают вручную.
 */
export function resolveOrderDirection(
  positions: GoodsPosition[],
  directionByGoodsId: Map<number, OrderDirection>,
): OrderDirection | null {
  const found = new Set<OrderDirection>();
  for (const position of positions) {
    const direction = directionByGoodsId.get(position.bsGoodsId);
    if (direction) found.add(direction);
  }
  return found.size === 1 ? [...found][0] : null;
}
