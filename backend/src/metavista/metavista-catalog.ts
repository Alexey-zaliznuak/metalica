import { MetavistaItem, MetavistaOrder } from './metavista.types';

// Exact equivalent products observed in the connected BS order catalog.
// Do not infer dimensions from M/L/XL: historical L can mean 61 × 45.7 cm.
export const METAVISTA_GOODS: Readonly<Record<string, number>> = Object.freeze({
  'classic:30x40': 486959,
  'classic:40x60': 486960,
  'classic:60x80': 486961,
});

export function matchingGoodsId(item: MetavistaItem): number | null {
  let width = item.configuration?.widthCm;
  let height = item.configuration?.heightCm;
  if (width == null || height == null) {
    const match = item.spec?.match(/(\d+(?:[.,]\d+)?)\s*[×xх*]\s*(\d+(?:[.,]\d+)?)/i);
    if (!match) return null;
    width = Number(match[1].replace(',', '.'));
    height = Number(match[2].replace(',', '.'));
  }
  if (typeof width !== 'number' || typeof height !== 'number' || width <= 0 || height <= 0) return null;
  const dimensions = [width, height].sort((a, b) => a - b).join('x');
  return METAVISTA_GOODS[`${item.productId}:${dimensions}`] ?? null;
}

/** Filter the basket, but keep the complete source total and actual payment.
 * sourceAmounts also restores full figures in snapshots saved by the old policy. */
export function selectMappedOrder(source: MetavistaOrder): MetavistaOrder {
  const amounts = source.sourceAmounts ?? {
    total: source.pricing.total, shipping: source.pricing.shipping, paidAmount: source.payment.paidAmount,
  };
  return {
    ...source,
    items: source.items.filter(i => matchingGoodsId(i) !== null),
    sourceAmounts: amounts,
    // Shipping and unsupported goods remain in the full total, allocated over
    // supported positions by buildBsOrder; no separate shipping product exists.
    pricing: { ...source.pricing, total: amounts.total, subtotal: amounts.total, discount: 0, shipping: 0 },
    payment: { ...source.payment, paidAmount: amounts.paidAmount },
  };
}
