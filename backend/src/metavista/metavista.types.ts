export interface MetavistaFile {
  id: string; slot: 'original' | 'final' | 'back'; mime: string; bytes: number;
  downloadUrl: string; width: number | null; height: number | null;
}
export interface MetavistaItem {
  id: number; productId: string; name: string; spec: string | null; qty: number;
  unitPrice: number; lineSubtotal: number; lineTotal: number | null;
  note: string | null; files: MetavistaFile[];
  configuration: Record<string, unknown> | null; backText: Record<string, unknown> | null;
}
export interface MetavistaOrder {
  sourceAmounts?: { total: number; shipping: number; paidAmount: number | null };
  schemaVersion: 1; id: string; revision: number; createdAt: string; updatedAt: string; status: string;
  customer: { firstName: string; lastName: string; email: string; phone: string | null };
  delivery: { address: string; city: string; zip: string; country: string; method: string; tracking: string | null; shippingPending: boolean };
  pricing: { currency: 'EUR'; subtotal: number; discount: number; shipping: number; total: number };
  payment: { status: string; paidAmount: number | null; paidAt: string | null };
  items: MetavistaItem[];
}
export interface MetavistaPage {
  schemaVersion: 1; orders: MetavistaOrder[];
  deletedOrders: { id: string; revision: number; deletedAt: string }[];
  nextCursor: number; hasMore: boolean;
}

export function validatePage(page: MetavistaPage, cursor: number): void {
  if (page?.schemaVersion !== 1 || !Array.isArray(page.orders) || !Array.isArray(page.deletedOrders)
    || !Number.isSafeInteger(page.nextCursor) || page.nextCursor < cursor || typeof page.hasMore !== 'boolean') {
    throw new Error('Некорректная страница Metavista');
  }
  const events = [...page.orders, ...page.deletedOrders];
  if (page.hasMore && page.nextCursor <= cursor) throw new Error('Metavista: курсор не продвинулся');
  for (const event of events) {
    if (!/^MV-\d{6}$/.test(event.id) || !Number.isSafeInteger(event.revision)
      || event.revision <= cursor || event.revision > page.nextCursor) throw new Error('Некорректная ревизия Metavista');
  }
  for (const order of page.orders) {
    if (order.schemaVersion !== 1 || order.pricing?.currency !== 'EUR' || !order.customer?.email
      || !order.delivery || typeof order.payment?.status !== 'string' || !Array.isArray(order.items)
      || !Number.isFinite(Date.parse(order.createdAt))
      || [order.pricing.total, order.pricing.shipping, order.pricing.subtotal, order.pricing.discount].some(n => !Number.isFinite(n) || n < 0)
      || (order.payment.paidAmount != null && (!Number.isFinite(order.payment.paidAmount) || order.payment.paidAmount < 0))) {
      throw new Error(`Некорректный заказ ${order.id}`);
    }
    for (const item of order.items) {
      if (!Number.isSafeInteger(item.id) || !Number.isSafeInteger(item.qty) || item.qty < 1
        || !item.productId || !item.name || !Number.isFinite(item.lineSubtotal) || item.lineSubtotal < 0
        || (item.lineTotal != null && (!Number.isFinite(item.lineTotal) || item.lineTotal < 0))
        || !Array.isArray(item.files)) throw new Error(`Некорректная позиция ${order.id}`);
      for (const file of item.files) {
        if (!/^[0-9a-f]{32}$/.test(file.id) || !['original', 'final', 'back'].includes(file.slot)
          || !['image/jpeg', 'image/png', 'image/webp'].includes(file.mime)
          || !Number.isSafeInteger(file.bytes) || file.bytes <= 0) throw new Error(`Некорректный файл ${order.id}`);
      }
    }
  }
  for (const deleted of page.deletedOrders) if (!Number.isFinite(Date.parse(deleted.deletedAt))) throw new Error('Некорректная дата удаления');
}

export function canExport(order: MetavistaOrder, paidStatuses: string[]): boolean {
  return paidStatuses.includes(order.payment.status.toLowerCase()) && !['cancelled', 'refunded'].includes(order.status);
}

export function orderMarker(id: string): string { return `Metavista: ${id}`; }
export function markerId(comments: unknown): string | null {
  return typeof comments === 'string' ? comments.match(/^Metavista: (MV-\d{6})\s*$/m)?.[1] ?? null : null;
}
