import { MetavistaOrder, orderMarker } from './metavista.types';
import { matchingGoodsId, selectMappedOrder } from './metavista-catalog';
import { METAVISTA_SETTINGS } from './metavista.config';

// Allocate rounded kopecks across lines, then split quantities where one unit
// cannot have an exact two-decimal price. The BS total equals the source total.
export function buildBsOrder(source: MetavistaOrder, customerId: number, rate: number) {
  const order = selectMappedOrder(source);
  if (!order.items.length) throw new Error('Metavista: пустой состав заказа');
  const total = Math.round(order.pricing.total * rate * 100);
  const prices = order.items.map(i => i.lineTotal ?? i.lineSubtotal);
  // Even zero-price supported goods must carry the full total when paid
  // unsupported goods/shipping were omitted. In that case weight by quantity.
  const weights = prices.some(p => p > 0) ? prices : order.items.map(i => i.qty);
  const sum = weights.reduce((a, b) => a + b, 0);
  const positions: { goods: { id: number } | { name: string }; size?: string; price: number; quantity: number }[] = [];
  let allocated = 0;
  let cumulative = 0;
  order.items.forEach((item, index) => {
    cumulative += weights[index];
    const target = index === order.items.length - 1 ? total : Math.round(total * cumulative / (sum || 1));
    const cents = target - allocated;
    allocated = target;
    const goods = { id: matchingGoodsId(item)! };
    const base = Math.floor(cents / item.qty), extra = cents % item.qty;
    if (item.qty - extra) positions.push({ goods, size: item.spec ?? undefined, price: base / 100, quantity: item.qty - extra });
    if (extra) positions.push({ goods, size: item.spec ?? undefined, price: (base + 1) / 100, quantity: extra });
  });
  return {
    customer: { id: customerId }, orderStatus: { name: METAVISTA_SETTINGS.statusName },
    goodsPositions: positions, discount: 0,
    prepay: Math.round((order.payment.paidAmount ?? order.pricing.total) * rate * 100) / 100,
    deliveryService: 2,
    delivery: { deliveryType: 3, customerName: `${order.customer.firstName} ${order.customer.lastName}`.trim(),
      mobilePhone: order.customer.phone ?? '', city: order.delivery.city,
      address: [order.delivery.country, order.delivery.zip, order.delivery.address].filter(Boolean).join(', ') },
    internalComments: [orderMarker(order.id), `Полная сумма Metavista: ${order.pricing.total} EUR; курс: ${rate} RUB/EUR; сумма включает доставку и позиции без соответствия в БС`,
      ...order.items.map(i => `${i.name} × ${i.qty}; ${i.spec ?? ''}; ${i.note ?? ''}\nПараметры: ${JSON.stringify(i.configuration)}\nОборот: ${JSON.stringify(i.backText)}`)].join('\n'),
    customerComments: order.items.map(i => i.note).filter(Boolean).join('\n'),
  };
}
