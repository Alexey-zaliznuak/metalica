import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Interval } from '@nestjs/schedule';
import { randomUUID } from 'crypto';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from '../storage/storage.service';
import { metavistaConfig } from './metavista.config';
import { MetavistaOrder, MetavistaPage, validatePage } from './metavista.types';
import { MetavistaBsService } from './metavista-bs.service';
import { EurRateService } from './eur-rate.service';
import { buildBsOrder } from './metavista-payload';
import { selectMappedOrder } from './metavista-catalog';
import { BluesalesSyncService } from '../bluesales/bluesales-sync.service';

@Injectable()
export class MetavistaService implements OnModuleInit {
  private readonly logger = new Logger(MetavistaService.name);
  private readonly settings;
  private running = false;
  private lockToken: string | null = null;
  private retryAfter = 0;
  constructor(private readonly prisma: PrismaService, config: ConfigService,
    private readonly storage: StorageService, private readonly bs: MetavistaBsService,
    private readonly rates: EurRateService, private readonly bsSync: BluesalesSyncService) { this.settings = metavistaConfig(config); }

  onModuleInit() {
    if (!this.settings.enabled) {
      this.logger.log('Metavista: импорт выключен (METAVISTA_ENABLED=false)');
    } else if (!this.settings.key) {
      this.logger.warn('Metavista: импорт не запущен — METAVISTA_API_KEY не задан');
    } else {
      this.logger.log(`Metavista: импорт включён; опрос каждые ${this.settings.pollMs / 1000} с; первый запуск — в течение 10 с; БС=${this.bs.api.isConfigured ? 'настроен' : 'не настроен'}`);
      if (!this.bs.api.isConfigured) this.logger.warn('Metavista: заказы будут сохраняться в CRM, но отправка в БС недоступна без настроек BlueSales');
    }
  }

  @Interval(10_000)
  async tick() {
    if (!this.settings.enabled || !this.settings.key || this.running) return;
    this.running = true;
    const token = randomUUID();
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    try {
      await this.prisma.metavistaSyncState.upsert({ where: { id: 1 }, create: { id: 1 }, update: {} });
      const claimed = await this.prisma.metavistaSyncState.updateMany({
        where: { id: 1, OR: [{ lockedUntil: null }, { lockedUntil: { lt: new Date() } }] },
        data: { lockToken: token, lockedUntil: new Date(Date.now() + 300_000) },
      });
      if (!claimed.count) return;
      this.lockToken = token;
      heartbeat = setInterval(() => {
        void this.prisma.metavistaSyncState.updateMany({ where: { id: 1, lockToken: token },
          data: { lockedUntil: new Date(Date.now() + 300_000) } }).then(r => {
            if (!r.count) this.lockToken = null;
          }).catch(() => { this.lockToken = null; });
      }, 30_000);
      const state = await this.prisma.metavistaSyncState.findUniqueOrThrow({ where: { id: 1 } });
      if (Date.now() >= this.retryAfter && (!state.lastPollAt || Date.now() - state.lastPollAt.getTime() >= this.settings.pollMs)) {
        try { await this.poll(); await this.logQueueSummary(); }
        catch (error) {
          const message = this.errorMessage(error);
          await this.prisma.metavistaSyncState.update({ where: { id: 1 }, data: { lastError: message, lastPollAt: new Date() } });
          this.logger.error(message);
        }
      }
      await this.requeuePreviouslyExcluded();
      // Delivery is independent of the input cursor: a BS outage never loses a
      // saved order and does not stop importing subsequent source pages.
      if (this.bs.api.isConfigured) {
        const pending = await this.prisma.metavistaOrder.findMany({
          where: { exportState: { in: ['PENDING', 'RETRY', 'REVIEW'] }, deletedAt: null, nextAttemptAt: { lte: new Date() } },
          orderBy: { nextAttemptAt: 'asc' }, take: 5,
        });
        if (pending.length) this.logger.log(`Metavista: обрабатываем очередь отправки в БС; заказов=${pending.length}`);
        for (const row of pending) {
          await this.assertLock();
          try { await this.exportOrder(row.externalId); }
          catch (error) {
            const current = await this.prisma.metavistaOrder.findUniqueOrThrow({ where: { externalId: row.externalId } });
            const review = !!(current.orderAttemptAt && !current.bsOrderId) || !!(current.customerAttemptAt && !current.bsCustomerId);
            await this.prisma.metavistaOrder.update({ where: { externalId: row.externalId }, data: {
              exportState: review ? 'REVIEW' : 'RETRY', lastError: this.errorMessage(error),
              nextAttemptAt: new Date(Date.now() + (review ? 3600_000 : 60_000)),
            } });
            this.logger.error(`Metavista ${row.externalId}: ${this.errorMessage(error)}`);
          }
        }
      }
    } catch (error) { this.logger.error(this.errorMessage(error)); }
    finally {
      if (heartbeat) clearInterval(heartbeat);
      this.lockToken = null;
      await this.prisma.metavistaSyncState.updateMany({ where: { id: 1, lockToken: token }, data: { lockToken: null, lockedUntil: null } }).catch(() => {});
      this.running = false;
    }
  }

  private async requeuePreviouslyExcluded() {
    const rows = await this.prisma.metavistaOrder.findMany({
      where: { deletedAt: null, exportState: { in: ['WAITING_PAYMENT', 'SKIPPED'] }, nextAttemptAt: { lte: new Date() } },
      orderBy: { nextAttemptAt: 'asc' }, take: 5,
    });
    for (const row of rows) {
      await this.assertLock();
      try {
        const order = await (await this.request(`/orders/${row.externalId}`)).json() as MetavistaOrder;
        if (order.id !== row.externalId) throw new Error('Metavista: неверный номер заказа в ответе');
        validatePage({ schemaVersion: 1, orders: [order], deletedOrders: [], nextCursor: order.revision, hasMore: false }, -1);
        await this.importOrder(order, true);
        this.logger.log(`Metavista ${row.externalId}: ранее пропущенный заказ обработан повторно`);
      } catch (error) {
        await this.prisma.metavistaOrder.update({ where: { externalId: row.externalId }, data: {
          lastError: this.errorMessage(error), nextAttemptAt: new Date(Date.now() + 60_000),
        } });
        this.logger.error(`Metavista ${row.externalId}: повторный импорт: ${this.errorMessage(error)}`);
      }
    }
  }

  private async logQueueSummary() {
    try {
      const groups = await this.prisma.metavistaOrder.groupBy({ by: ['exportState'], _count: { _all: true } });
      const states = Object.fromEntries(groups.map(g => [g.exportState, g._count._all]));
      this.logger.log(`Metavista: состояние заказов ${JSON.stringify(states)}; все существующие заказы передаются в БС независимо от оплаты и статуса`);
    } catch {
      // Diagnostic failures must not turn a successful import into a retry.
      this.logger.warn('Metavista: не удалось получить сводку очереди');
    }
  }

  private errorMessage(error: unknown) {
    // Never retain the bearer key even if a transport library includes it.
    const message = error instanceof Error ? error.message : 'Ошибка интеграции';
    return (this.settings.key ? message.split(this.settings.key).join('[redacted]') : message).slice(0, 1000);
  }
  private async assertLock() {
    if (!this.lockToken) throw new Error('Блокировка импорта Metavista потеряна');
    const state = await this.prisma.metavistaSyncState.findUniqueOrThrow({ where: { id: 1 } });
    if (state.lockToken !== this.lockToken || !state.lockedUntil || state.lockedUntil.getTime() <= Date.now()) throw new Error('Блокировка импорта Metavista истекла');
  }
  private async request(path: string) {
    await this.assertLock();
    if (Date.now() < this.retryAfter) throw new Error('Metavista: ожидаем Retry-After');
    const response = await fetch(`${this.settings.baseUrl}${path}`, {
      headers: { Authorization: `Bearer ${this.settings.key}` },
      signal: AbortSignal.timeout(this.settings.timeoutMs), redirect: 'error',
    });
    if (!response.ok) {
      if (response.status === 429) {
        const header = response.headers.get('Retry-After');
        const seconds = Number(header);
        this.retryAfter = Number.isFinite(seconds) && seconds > 0 ? Date.now() + seconds * 1000 : Math.max(Date.now() + 60_000, Date.parse(header ?? '') || 0);
      }
      throw new Error(`Metavista HTTP ${response.status}`);
    }
    return response;
  }
  async poll() {
    const startedAt = Date.now();
    const state = await this.prisma.metavistaSyncState.findUniqueOrThrow({ where: { id: 1 } });
    let cursor = state.cursor;
    if (!state.initialized) {
      if (!this.settings.importHistory) {
        const status = await (await this.request('/status')).json() as { latestRevision: number };
        if (!Number.isSafeInteger(status.latestRevision) || status.latestRevision < 0) throw new Error('Некорректный статус Metavista');
        cursor = status.latestRevision;
      }
      await this.prisma.metavistaSyncState.update({ where: { id: 1 }, data: { initialized: true, cursor } });
    }
    // Continue backlog on subsequent ticks; only commit a fully saved page.
    this.logger.log(`Metavista: запрашиваем изменения; курсор=${cursor}`);
    const page = await (await this.request(`/orders?after=${cursor}&limit=${this.settings.pageSize}`)).json() as MetavistaPage;
    validatePage(page, cursor);
    const events = [...page.orders.map(order => ({ revision: order.revision, order })),
      ...page.deletedOrders.map(deleted => ({ revision: deleted.revision, deleted }))].sort((a, b) => a.revision - b.revision);
    for (const event of events) {
      await this.assertLock();
      if ('order' in event) await this.importOrder(event.order);
      else {
        const d = event.deleted;
        const existing = await this.prisma.metavistaOrder.findUnique({ where: { externalId: d.id } });
        if (existing && existing.revision >= d.revision) continue;
        await this.prisma.metavistaOrder.upsert({ where: { externalId: d.id },
          create: { externalId: d.id, revision: d.revision, deletedAt: new Date(d.deletedAt), exportState: 'DELETED' },
          update: { revision: d.revision, deletedAt: new Date(d.deletedAt), exportState: 'DELETED', snapshot: Prisma.DbNull },
        });
        this.logger.log(`Metavista ${d.id}: удаление источника обработано; ревизия=${d.revision}`);
      }
    }
    await this.assertLock();
    await this.prisma.metavistaSyncState.update({ where: { id: 1 }, data: {
      cursor: page.nextCursor, lastError: null, lastPollAt: page.hasMore ? null : new Date(),
    } });
    this.logger.log(`Metavista: опрос завершён; заказов=${page.orders.length}; удалений=${page.deletedOrders.length}; курсор=${cursor}→${page.nextCursor}; ещёСтраницы=${page.hasMore}; время=${Date.now() - startedAt} мс`);
  }
  async importOrder(sourceOrder: MetavistaOrder, replay = false) {
    const order = sourceOrder;
    let row = await this.prisma.metavistaOrder.findUnique({ where: { externalId: order.id } });
    if (row && (row.revision > order.revision || (row.revision === order.revision && !replay))) return;
    this.logger.log(`Metavista ${order.id}: обрабатываем ревизию=${order.revision}; товаров=${order.items.length}; файлов=${order.items.reduce((n, item) => n + item.files.length, 0)}`);
    if (!row?.orderId) {
      row = await this.prisma.$transaction(async tx => {
        const local = await tx.order.create({ data: { orderNumber: order.id, title: `Metavista ${order.id}`, createdAt: new Date(order.createdAt) } });
        return tx.metavistaOrder.upsert({ where: { externalId: order.id },
          create: { externalId: order.id, orderId: local.id }, update: { orderId: local.id } });
      });
    }
    const orderId = row.orderId!;
    for (const item of order.items) for (const file of item.files) {
      const unique = { externalId: order.id, itemId: item.id, fileId: file.id, slot: file.slot };
      if (await this.prisma.metavistaFile.findUnique({ where: { externalId_itemId_fileId_slot: unique } })) continue;
      if (file.bytes > this.settings.maxFileBytes) throw new Error(`Файл ${file.id} превышает лимит 100 МБ`);
      // Build the route ourselves: never send a key to a supplied downloadUrl.
      const response = await this.request(`/orders/${order.id}/files/${file.id}`);
      const contentType = response.headers.get('content-type')?.split(';')[0];
      if (contentType !== file.mime) throw new Error(`Тип файла ${file.id} не совпадает с Metavista`);
      const chunks: Buffer[] = []; let bytes = 0;
      if (!response.body) throw new Error('Пустой файл Metavista');
      const reader = response.body.getReader();
      try {
        for (;;) {
          const chunk = await reader.read(); if (chunk.done) break;
          bytes += chunk.value.length;
          if (bytes > this.settings.maxFileBytes || bytes > file.bytes) throw new Error('Превышен размер файла Metavista');
          chunks.push(Buffer.from(chunk.value));
        }
      } finally { await reader.cancel().catch(() => {}); }
      if (bytes !== file.bytes) throw new Error('Файл Metavista скачан не полностью');
      const ext = file.mime === 'image/jpeg' ? 'jpg' : file.mime === 'image/png' ? 'png' : 'webp';
      const filename = `${order.id}-${item.id}-${file.slot}-${file.id}.${ext}`;
      const uploaded = await this.storage.upload({ originalname: filename, mimetype: file.mime, buffer: Buffer.concat(chunks), size: bytes });
      const meta = await this.storage.stat(uploaded.key);
      await this.prisma.$transaction(async tx => {
        const attachment = file.slot !== 'original' ? await tx.attachment.create({ data: {
          printPhotoOrderId: orderId, objectKey: uploaded.key, filename, mimeType: file.mime, size: bytes,
          kind: file.slot === 'back' ? 'print-inscription' : 'print-photo', ...meta?.previews,
        } }) : null;
        await tx.metavistaFile.create({ data: { ...unique, objectKey: uploaded.key, filename, mimeType: file.mime, size: bytes, attachmentId: attachment?.id } });
      });
    }
    await this.assertLock();
    // Detach only obsolete imported print files. Manual uploads are unaffected.
    const files = await this.prisma.metavistaFile.findMany({ where: { externalId: order.id } });
    const active = new Set(order.items.flatMap(item => item.files.map(file => `${item.id}:${file.id}:${file.slot}`)));
    for (const file of files) if (file.attachmentId) {
      await this.prisma.attachment.updateMany({ where: { id: file.attachmentId },
        data: { printPhotoOrderId: active.has(`${file.itemId}:${file.fileId}:${file.slot}`) ? orderId : null } });
    }
    const current = await this.prisma.metavistaOrder.findUniqueOrThrow({ where: { externalId: order.id } });
    await this.prisma.metavistaOrder.update({ where: { externalId: order.id }, data: {
      revision: order.revision, snapshot: order as unknown as Prisma.InputJsonValue, deletedAt: null,
      paymentStatus: order.payment.status, totalEur: sourceOrder.pricing.total,
      exportState: current.bsOrderId ? 'EXPORTED' : 'PENDING',
      lastError: null, nextAttemptAt: new Date(),
    } });
    const reason = current.bsOrderId ? 'уже связан с БС' : 'готов к отправке в БС';
    this.logger.log(`Metavista ${order.id}: сохранён в CRM; ${reason}`);
  }

  async exportOrder(externalId: string) {
    let row = await this.prisma.metavistaOrder.findUniqueOrThrow({ where: { externalId } });
    const snapshot = row.snapshot as unknown as MetavistaOrder;
    const order = snapshot;
    if (row.deletedAt || !row.orderId || !order) return;
    if (row.bsOrderId) {
      await this.prisma.metavistaOrder.update({ where: { externalId }, data: { exportState: 'EXPORTED', lastError: null } });
      return;
    }
    const tagId = await this.bs.tagId();
    let customer = row.bsCustomerId ? await this.bs.customer(row.bsCustomerId) : await this.bs.findCustomer(order);
    if (!customer) {
      if (row.customerAttemptAt) throw new Error('Результат создания клиента неизвестен. Автоповтор запрещён; проверьте БС');
      await this.assertLock();
      await this.prisma.metavistaOrder.update({ where: { externalId }, data: { customerAttemptAt: new Date() } });
      try { customer = await this.bs.send('customers.add', {
        fullName: `${order.customer.firstName} ${order.customer.lastName}`.trim(), email: order.customer.email,
        phone: order.customer.phone ?? '', country: { name: order.delivery.country }, city: { name: order.delivery.city },
        address: `${order.delivery.zip} ${order.delivery.address}`, tags: [{ id: tagId }],
      }); } catch (error) {
        if (this.bs.isRejected(error)) await this.prisma.metavistaOrder.update({ where: { externalId }, data: { customerAttemptAt: null } });
        throw error;
      }
      if (!customer?.id) throw new Error('БС не вернул ID созданного клиента');
    }
    await this.prisma.metavistaOrder.update({ where: { externalId }, data: { bsCustomerId: customer.id } });
    // Read current tags just before updating: don't replace them with a stale set.
    customer = await this.bs.customer(customer.id!);
    await this.assertLock();
    await this.bs.ensureTag(customer, tagId);
    const lead = await this.prisma.lead.upsert({ where: { bsCustomerId: customer.id },
      create: { bsCustomerId: customer.id, fullName: customer.fullName, tags: { connect: { bsTagId: String(tagId) } } },
      update: { tags: { connect: { bsTagId: String(tagId) } } },
    });
    await this.prisma.order.update({ where: { id: row.orderId }, data: { leadId: lead.id } });
    let bsOrder = await this.bs.findOrder(customer.id!, externalId);
    if (!bsOrder) {
      if (row.orderAttemptAt) throw new Error('Результат создания заказа неизвестен. Автоповтор запрещён; проверьте БС');
      if (!row.exchangeRate) {
        const rate = await this.rates.current();
        row = await this.prisma.metavistaOrder.update({ where: { externalId }, data: { exchangeRate: rate.rate, rateSource: rate.source } });
      }
      const payload = buildBsOrder(order, customer.id!, Number(row.exchangeRate));
      await this.assertLock();
      await this.prisma.metavistaOrder.update({ where: { externalId }, data: { orderAttemptAt: new Date() } });
      try { bsOrder = await this.bs.send('orders.add', payload); }
      catch (error) {
        if (this.bs.isRejected(error)) await this.prisma.metavistaOrder.update({ where: { externalId }, data: { orderAttemptAt: null } });
        throw error;
      }
      if (!bsOrder?.id) throw new Error('БС не вернул ID созданного заказа');
    }
    await this.linkOrder(externalId, bsOrder.id, customer.id!, lead.id);
    this.logger.log(`Metavista ${externalId}: успешно связан с заказом БС #${bsOrder.id}`);
    // Fetch the actual BS status ID and payload immediately; subsequent inbound
    // refreshes use the saved bsOrderId and never create another local card.
    const actual = await this.bs.api.getOrdersByIds([bsOrder.id], 'background', false);
    if (actual[0]) await this.bsSync.upsertOrder(actual[0], lead.id);
  }
  async linkOrder(externalId: string, bsOrderId: number, bsCustomerId: number, leadId: number) {
    await this.prisma.$transaction(async tx => {
      const row = await tx.metavistaOrder.findUniqueOrThrow({ where: { externalId } });
      if (!row.orderId) throw new Error('Локальная карточка Metavista удалена');
      const linked = await tx.bluesalesOrderInfo.findUnique({ where: { bsOrderId } });
      if (linked && linked.orderId !== row.orderId) throw new Error('Заказ БС уже связан с другой карточкой');
      const snapshot = row.snapshot as unknown as MetavistaOrder;
      const fullTotal = selectMappedOrder(snapshot).pricing.total;
      await tx.bluesalesOrderInfo.upsert({ where: { orderId: row.orderId },
        create: { orderId: row.orderId, bsOrderId, bsCustomerId, orderStatus: this.settings.statusName,
          orderStatusId: this.settings.statusId, orderStatusEnteredAt: new Date(), bsCreatedAt: new Date(),
          totalSum: row.exchangeRate ? Math.round(fullTotal * Number(row.exchangeRate) * 100) / 100 : null },
        update: {},
      });
      await tx.order.update({ where: { id: row.orderId }, data: { source: 'BLUESALES', leadId } });
      await tx.metavistaOrder.update({ where: { externalId }, data: { bsOrderId, bsCustomerId, exportState: 'EXPORTED', lastError: null } });
    });
  }
}
