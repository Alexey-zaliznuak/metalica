import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BsCustomer, BsOrder, BluesalesApiService, BluesalesRejectedError, BluesalesBusyError, BluesalesAuthError } from '../bluesales/bluesales-api.service';
import { PrismaService } from '../prisma/prisma.service';
import { metavistaConfig } from './metavista.config';
import { markerId, MetavistaOrder } from './metavista.types';

@Injectable()
export class MetavistaBsService {
  readonly settings;
  constructor(readonly api: BluesalesApiService, private readonly prisma: PrismaService, config: ConfigService) {
    this.settings = metavistaConfig(config);
  }
  send<T>(method: string, data: unknown): Promise<T> {
    // Retry creation through the durable import queue, with its normal backoff.
    return this.api.send<T>(method, data, { priority: 'background', respectSyncSchedule: false, label: 'metavista' });
  }
  private async list<T>(method: string, key: string, filters: object): Promise<T[]> {
    const result: T[] = [];
    for (let offset = 0; ;) {
      const page = await this.send<Record<string, unknown>>(method, { ...filters, pageSize: 500, startRowNumber: offset });
      const rows = page[key];
      if (!Array.isArray(rows)) throw new Error(`Некорректный ответ ${method}`);
      result.push(...rows);
      if (page.notReturnedCount === 0) break;
      if (!rows.length || offset > 1_000_000) throw new Error(`Незавершённая выборка ${method}`);
      if (typeof page.notReturnedCount !== 'number') throw new Error(`Нет признака конца выборки ${method}`);
      offset += rows.length;
    }
    return result;
  }
  async findCustomer(order: MetavistaOrder): Promise<BsCustomer | null> {
    const email = order.customer.email.trim().toLowerCase();
    if (!email) throw new Error('Не указан email клиента Metavista');
    const leads = await this.prisma.lead.findMany({
      where: { email, bsCustomerId: { not: null } }, select: { bsCustomerId: true },
      orderBy: { bsCustomerId: 'asc' }, take: 1,
    });
    // Older imports and interrupted exports may already know the BS ID before
    // the local lead has been saved. Reuse that durable association as well.
    const previous = await this.prisma.$queryRaw<Array<{ bsCustomerId: number }>>`
      SELECT DISTINCT "bsCustomerId"
      FROM "MetavistaOrder"
      WHERE lower(btrim("snapshot" #>> '{customer,email}')) = ${email}
        AND "bsCustomerId" IS NOT NULL`;
    // Duplicates are accepted: choose a stable known ID, or create a customer
    // again when an earlier attempt never saved its result.
    const ids = [...new Set([...leads, ...previous].map(c => c.bsCustomerId).filter((id): id is number => id != null))].sort((a, b) => a - b);
    if (ids.length) return { id: ids[0] };
    return null;
  }
  async customer(id: number) {
    const response = await this.send<{ customers: BsCustomer[] }>('customers.get', { ids: [id], pageSize: 1, startRowNumber: 0 });
    const customer = response.customers?.find(c => c.id === id);
    if (!customer) throw new Error('Клиент БС не найден');
    return customer;
  }
  async findOrder(customerId: number, externalId: string) {
    const orders = await this.list<BsOrder>('orders.get', 'orders', { customerId, dateFrom: null, dateTill: null, orderStatuses: [], ids: null, internalNumbers: null });
    const found = orders.filter(o => markerId(o.internalComments) === externalId).sort((a, b) => a.id - b.id);
    return found[0] ?? null;
  }
  async tagId(): Promise<number> {
    return this.settings.tagId;
  }
  isRejected(error: unknown) { return error instanceof BluesalesRejectedError || error instanceof BluesalesBusyError || error instanceof BluesalesAuthError; }
  async ensureTag(customer: BsCustomer, tagId: number) {
    const tags = customer.tags ?? [];
    if (!tags.some(t => t.id === tagId)) {
      await this.send('customers.update', { id: customer.id, tags: [...tags.map(t => ({ id: t.id })), { id: tagId }] });
    }
    await this.prisma.bluesalesTag.upsert({ where: { bsTagId: String(tagId) },
      create: { bsTagId: String(tagId), name: this.settings.tagName }, update: {} });
  }
}
