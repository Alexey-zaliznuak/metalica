import { Prisma } from '@prisma/client';

class ProductionOrderData {
  extractArticles(rawPayload: Prisma.JsonValue | null | undefined): Array<{
    article: string | null;
    name: string | null;
    quantity: number | null;
    size: string | null;
    comment: string | null;
  }> {
    if (!rawPayload || typeof rawPayload !== 'object' || Array.isArray(rawPayload)) {
      return [];
    }
    const order = rawPayload as Record<string, unknown>;

    const positionsKeys = [
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
    ];
    let positions: unknown[] = [];
    for (const key of positionsKeys) {
      const value = order[key];
      if (Array.isArray(value) && value.length > 0) {
        positions = value;
        break;
      }
    }
    if (positions.length === 0) {
      return [];
    }

    const result: Array<{
      article: string | null;
      name: string | null;
      quantity: number | null;
      size: string | null;
      comment: string | null;
    }> = [];
    for (const raw of positions) {
      if (!raw || typeof raw !== 'object') continue;
      const pos = raw as Record<string, unknown>;
      const product =
        pos.product && typeof pos.product === 'object'
          ? (pos.product as Record<string, unknown>)
          : {};
      const nomenclature =
        pos.nomenclature && typeof pos.nomenclature === 'object'
          ? (pos.nomenclature as Record<string, unknown>)
          : {};
      // В ответе BlueSales позиция товара называется `goods`, а артикул лежит
      // в поле `marking` (см. order_raw_payload.json).
      const goods =
        pos.goods && typeof pos.goods === 'object'
          ? (pos.goods as Record<string, unknown>)
          : {};

      const article = this.pickString(
        pos.marking,
        pos.article,
        pos.articul,
        pos.vendorCode,
        pos.sku,
        pos.code,
        pos.productArticle,
        pos.productCode,
        goods.marking,
        goods.article,
        goods.articul,
        goods.vendorCode,
        goods.sku,
        goods.code,
        product.article,
        product.articul,
        product.vendorCode,
        product.sku,
        product.code,
        nomenclature.article,
        nomenclature.articul,
        nomenclature.vendorCode,
        nomenclature.code,
      );
      const name = this.pickString(
        pos.name,
        pos.productName,
        pos.title,
        goods.name,
        goods.title,
        product.name,
        product.title,
        nomenclature.name,
      );
      const quantity = this.pickNumber(pos.count, pos.quantity, pos.amount, pos.qty, pos.number);
      const size = this.pickString(pos.size, pos.sizeName, goods.size, product.size);
      const comment = this.extractPositionComment(pos);

      if (article === null && name === null) continue;
      result.push({ article, name, quantity, size, comment });
    }
    return this.mergePlainArticles(result);
  }

  /**
   * Склеивает одинаковые артикулы в одну строку с суммой количества.
   * Только позиции без размера и без комментария: у «доп лицо ×4» в BS
   * часто четыре отдельные строки по 1 шт, а упаковка с размером/комментом
   * должна остаться отдельными строками.
   */
  private mergePlainArticles(
    items: Array<{
      article: string | null;
      name: string | null;
      quantity: number | null;
      size: string | null;
      comment: string | null;
    }>,
  ) {
    const merged: typeof items = [];
    const indexByKey = new Map<string, number>();
    for (const item of items) {
      if (item.size !== null || item.comment !== null) {
        merged.push(item);
        continue;
      }
      const key = `${item.article ?? ''}\0${item.name ?? ''}`;
      const existingIndex = indexByKey.get(key);
      if (existingIndex === undefined) {
        indexByKey.set(key, merged.length);
        merged.push({ ...item });
        continue;
      }
      const existing = merged[existingIndex];
      existing.quantity = (existing.quantity ?? 1) + (item.quantity ?? 1);
    }
    return merged;
  }

  /**
   * Комментарий позиции: сначала прямые поля, затем кастомное поле
   * «Комментарии» / «Примечание» из BlueSales.
   */
  private extractPositionComment(pos: Record<string, unknown>): string | null {
    const direct = this.pickString(
      pos.comment,
      pos.comments,
      pos.note,
      pos.internalComments,
    );
    if (direct) return direct;

    const fields = Array.isArray(pos.customFields) ? pos.customFields : [];
    for (const raw of fields) {
      if (!raw || typeof raw !== 'object') continue;
      const field = raw as Record<string, unknown>;
      const fieldName = String(field.fieldName ?? '')
        .trim()
        .toLocaleLowerCase('ru-RU');
      if (!fieldName.includes('комментари') && !fieldName.includes('примечан')) {
        continue;
      }
      const value = this.pickString(field.valueAsText, field.value);
      if (value) return value;
    }
    return null;
  }

  resolveDeliveryService(value: unknown): string | null {
    if (value && typeof value === 'object') {
      const named = value as Record<string, unknown>;
      return this.pickString(named.name, named.title);
    }
    const code = this.pickNumber(value);
    if (code === 2) return 'Собственными силами';
    if (code === 5) return 'СДЭК';
    return this.pickString(value);
  }

  private pickString(...values: unknown[]): string | null {
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

  private pickNumber(...values: unknown[]): number | null {
    for (const value of values) {
      if (typeof value === 'number' && Number.isFinite(value)) return value;
      if (typeof value === 'string') {
        const normalized = value.trim().replace(',', '.');
        if (!normalized) continue;
        const parsed = Number(normalized);
        if (Number.isFinite(parsed)) return parsed;
      }
    }
    return null;
  }

  context(orderNumber: string, rawPayload: Prisma.JsonValue | null | undefined, photoNumber?: number) {
    const payload = rawPayload && typeof rawPayload === 'object' && !Array.isArray(rawPayload) ? rawPayload as Record<string, unknown> : {};
    return { orderNumber, photoNumber: photoNumber ?? null, articles: this.extractArticles(rawPayload), comment: this.pickString(payload.internalComments), deliveryService: this.resolveDeliveryService(payload.deliveryService) };
  }
}

export const productionOrderData = new ProductionOrderData();
