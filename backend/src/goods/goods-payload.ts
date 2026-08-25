/** Позиция товара заказа, приведённая к ключу справочника BluesalesGoods. */
export interface GoodsPosition {
  bsGoodsId: number;
  name: string;
  marking: string | null;
}

// Названия полей в ответе BlueSales формально не типизированы и варьируются,
// поэтому позиции и их атрибуты ищем перебором вероятных ключей — так же, как
// это уже сделано в OrdersService.extractArticles и в синке.
const POSITIONS_KEYS = [
  'goodsPositions',
  'orderProducts',
  'products',
  'orderItems',
  'items',
  'positions',
  'goods',
  'lines',
  'productList',
  'orderProductList',
] as const;

const GOODS_KEYS = ['goods', 'product', 'nomenclature'] as const;

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function pickString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (trimmed.length > 0) return trimmed;
    } else if (typeof value === 'number' && Number.isFinite(value)) {
      return String(value);
    }
  }
  return null;
}

function pickId(...values: unknown[]): number | null {
  for (const value of values) {
    if (typeof value === 'number' && Number.isInteger(value) && value > 0) return value;
    if (typeof value === 'string') {
      const parsed = Number(value.trim());
      if (Number.isInteger(parsed) && parsed > 0) return parsed;
    }
  }
  return null;
}

/**
 * Достаёт из «сырого» заказа BlueSales позиции товаров в виде записей справочника.
 * Позиции без распознанного id товара отбрасываются — по нему справочник
 * связывается с заказом. Дубликаты одного товара в заказе схлопываются.
 */
export function extractGoodsPositions(rawPayload: unknown): GoodsPosition[] {
  const order = asRecord(rawPayload);

  let positions: unknown[] = [];
  for (const key of POSITIONS_KEYS) {
    const value = order[key];
    if (Array.isArray(value) && value.length > 0) {
      positions = value;
      break;
    }
  }

  const byId = new Map<number, GoodsPosition>();
  for (const raw of positions) {
    const pos = asRecord(raw);
    const nested = GOODS_KEYS.map((key) => asRecord(pos[key]));

    const bsGoodsId = pickId(
      ...nested.map((item) => item.id),
      ...nested.map((item) => item.goodsId),
      pos.goodsId,
      pos.productId,
      pos.nomenclatureId,
    );
    if (bsGoodsId === null || byId.has(bsGoodsId)) continue;

    const marking = pickString(
      ...nested.map((item) => item.marking),
      ...nested.map((item) => item.article),
      ...nested.map((item) => item.vendorCode),
      ...nested.map((item) => item.sku),
      pos.marking,
      pos.article,
      pos.vendorCode,
      pos.sku,
    );
    const name = pickString(
      ...nested.map((item) => item.name),
      ...nested.map((item) => item.title),
      pos.name,
      pos.productName,
      pos.title,
      marking,
    );
    if (name === null) continue;

    byId.set(bsGoodsId, { bsGoodsId, name, marking });
  }

  return [...byId.values()];
}
