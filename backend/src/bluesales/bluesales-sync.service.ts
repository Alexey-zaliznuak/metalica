import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { OrderSource, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { BluesalesApiService, BsCustomer, BsOrder } from './bluesales-api.service';

const SYNC_KEY_FAST = 'bluesales:fast-sync';
const SYNC_KEY_REFRESH = 'bluesales:refresh-loop';

/** Перекрытие окна инкрементального синка — берём с запасом, чтобы не пропустить заказы на границе. */
const FAST_SYNC_OVERLAP_MINUTES = 70;

const REFRESH_BATCH_SIZE = 50;
const REFRESH_PAUSE_MS = 3000;
/** Заказы не старше 2 месяцев попадают в фоновый обход. */
const REFRESH_LOOKBACK_DAYS = 60;

@Injectable()
export class BluesalesSyncService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(BluesalesSyncService.name);
  private readonly enabled: boolean;
  private readonly vkGroupId: string;

  /** Защита от параллельного запуска быстрого синка. */
  private fastSyncRunning = false;
  /** Флаг остановки фонового цикла (выставляется при shutdown). */
  private loopActive = false;

  constructor(
    private readonly api: BluesalesApiService,
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {
    this.enabled = this.config.get<string>('BLUESALES_ENABLED', 'true') !== 'false';
    this.vkGroupId = this.config.get<string>('BLUESALES_VK_GROUP_ID', '');
  }

  onModuleInit(): void {
    if (!this.enabled) {
      this.logger.warn('BlueSales sync отключён (BLUESALES_ENABLED=false)');
      return;
    }
    if (!this.api.isConfigured) {
      this.logger.warn(
        'BlueSales sync включён, но не заданы BLUESALES_LOGIN / BLUESALES_PASSWORD',
      );
      return;
    }
    this.logger.log('BlueSales sync активен: быстрый cron каждые 5 мин + фоновый refresh-loop');
    this.loopActive = true;
    // Запускаем цикл после небольшой паузы, чтобы приложение успело подняться.
    setTimeout(() => void this.runRefreshLoop(), 5000);
  }

  onModuleDestroy(): void {
    this.loopActive = false;
  }

  // ─── Быстрый инкрементальный синк (каждые 5 минут) ────────────────────────

  /**
   * Каждые 5 минут тянет заказы за последние ~70 минут и досоздаёт новые.
   * Перекрытие 70 мин исключает пропуск заказов на границе интервалов.
   */
  @Cron('*/5 * * * *')
  async handleFastSync(): Promise<void> {
    if (!this.enabled || !this.api.isConfigured) return;
    if (this.fastSyncRunning) {
      this.logger.debug('Быстрый синк ещё выполняется — пропуск');
      return;
    }
    this.fastSyncRunning = true;
    try {
      await this.runFastSync();
    } catch (err) {
      this.logger.error(`Быстрый синк BS ошибка: ${(err as Error).message}`);
      await this.markError(SYNC_KEY_FAST, (err as Error).message);
    } finally {
      this.fastSyncRunning = false;
    }
  }

  async runFastSync(): Promise<{ orders: number; leads: number }> {
    const now = new Date();
    const dateFrom = new Date(now.getTime() - FAST_SYNC_OVERLAP_MINUTES * 60 * 1000);

    await this.markRun(SYNC_KEY_FAST);

    let bsOrders: BsOrder[];
    try {
      bsOrders = await this.api.getOrders(dateFrom, now);
    } catch (err) {
      await this.markError(SYNC_KEY_FAST, (err as Error).message);
      throw err;
    }

    const leadIds = new Set<number>();
    let synced = 0;

    for (const bsOrder of bsOrders) {
      try {
        const leadId = await this.upsertLead(bsOrder.customer ?? null);
        if (leadId) leadIds.add(leadId);
        await this.upsertOrder(bsOrder, leadId);
        synced++;
      } catch (err) {
        this.logger.error(
          `Быстрый синк: не удалось обработать BS#${bsOrder.id}: ${(err as Error).message}`,
        );
      }
    }

    await this.markSuccess(SYNC_KEY_FAST, synced);
    this.logger.log(`Быстрый синк BS: заказов ${synced}/${bsOrders.length}, лидов ${leadIds.size}`);
    return { orders: synced, leads: leadIds.size };
  }

  // ─── Фоновый refresh-loop ──────────────────────────────────────────────────

  /**
   * Бесконечный цикл: берёт батч из 20 самых давно обновлённых заказов
   * (не старше 2 месяцев) и актуализирует их через ids-фильтр BS API.
   * Между итерациями — пауза 1 с, чтобы другие операции могли использовать API.
   */
  private async runRefreshLoop(): Promise<void> {
    this.logger.log('Фоновый refresh-loop запущен');

    while (this.loopActive) {
      try {
        await this.refreshBatch();
      } catch (err) {
        this.logger.error(`Refresh-loop ошибка: ${(err as Error).message}`);
        await this.markError(SYNC_KEY_REFRESH, (err as Error).message);
      }

      // Пауза даёт другим запросам к BS API (от менеджеров) попасть в очередь.
      await this.sleep(REFRESH_PAUSE_MS);
    }

    this.logger.log('Фоновый refresh-loop остановлен');
  }

  private async refreshBatch(): Promise<void> {
    // Засекаем время именно одной итерации: выборка из БД + запрос в BS + upsert в нашу БД.
    const startedAt = Date.now();

    // Refresh-loop не трогает старые архивные заказы. Сейчас обновляем только заказы
    // с датой создания в BS не старше REFRESH_LOOKBACK_DAYS (60 дней).
    const lookbackDate = new Date(Date.now() - REFRESH_LOOKBACK_DAYS * 24 * 60 * 60 * 1000);

    // Берём небольшую пачку заказов, которые дольше всего не обновлялись.
    // lastSyncedAt обновляется после каждого успешного upsert, поэтому такая сортировка
    // равномерно "прокручивает" все актуальные заказы по кругу.
    const batch = await this.prisma.bluesalesOrderInfo.findMany({
      where: {
        bsCreatedAt: { gte: lookbackDate },
      },
      orderBy: { lastSyncedAt: 'asc' },
      take: REFRESH_BATCH_SIZE,
      select: { bsOrderId: true, lastSyncedAt: true },
    });

    if (batch.length === 0) {
      // Нет заказов для обновления — ждём подольше, чтобы не спамить в БД.
      await this.sleep(10_000);
      return;
    }

    const ids = batch.map((b) => b.bsOrderId);
    // Так как batch отсортирован по lastSyncedAt ASC, первый элемент — самый
    // давно синхронизированный заказ. Этот лаг показывает, за сколько времени
    // refresh-loop делает полный круг по актуальным заказам.
    const oldestSyncLagMs = startedAt - batch[0].lastSyncedAt.getTime();

    // Фиксируем старт прогона в SyncState, чтобы в БД было видно,
    // что refresh-loop живой и когда он последний раз запускался.
    await this.markRun(SYNC_KEY_REFRESH);

    let bsOrders: BsOrder[];
    try {
      // Один лёгкий запрос к BlueSales по ids вместо тяжёлой выгрузки за период.
      // Внутри api.getOrdersByIds всё равно используется общий mutex, поэтому
      // параллельных запросов к BS из нашего бэкенда не будет.
      bsOrders = await this.api.getOrdersByIds(ids);
    } catch (err) {
      await this.markError(SYNC_KEY_REFRESH, (err as Error).message);
      throw err;
    }

    // Нужно понять, какие id BlueSales вернул. Если какого-то id нет в ответе,
    // это может означать удаление/недоступность заказа; обработаем это ниже.
    const returnedIds = new Set(bsOrders.map((o) => o.id));
    let synced = 0;

    for (const bsOrder of bsOrders) {
      try {
        // В ответе заказа лежит customer, поэтому обновляем лида и сам заказ вместе.
        // upsertOrder также обновит BluesalesOrderInfo.lastSyncedAt.
        const leadId = await this.upsertLead(bsOrder.customer ?? null);
        await this.upsertOrder(bsOrder, leadId);
        synced++;
      } catch (err) {
        this.logger.error(
          `Refresh-loop: не удалось обработать BS#${bsOrder.id}: ${(err as Error).message}`,
        );
      }
    }

    // Для заказов, которые BS не вернул (удалены / недоступны), всё равно
    // обновляем lastSyncedAt, чтобы они не застряли наверху очереди.
    const missingIds = ids.filter((id) => !returnedIds.has(id));
    if (missingIds.length > 0) {
      await this.prisma.bluesalesOrderInfo.updateMany({
        where: { bsOrderId: { in: missingIds } },
        data: { lastSyncedAt: new Date() },
      });
    }

    await this.markSuccess(SYNC_KEY_REFRESH, synced);

    // Логируем длительность пачки, чтобы видеть, сколько времени API BS и upsert
    // реально занимают на REFRESH_BATCH_SIZE заказов.
    const elapsedMs = Date.now() - startedAt;
    this.logger.debug(
      `Refresh-loop: обновлено ${synced}, пропущено (нет в BS) ${missingIds.length}, время батча ${elapsedMs} мс, лаг старейшего ${this.formatDuration(oldestSyncLagMs)}`,
    );
  }

  // ─── Upsert-логика (общая для обоих процессов) ────────────────────────────

  async upsertLead(customer: BsCustomer | null): Promise<number | null> {
    if (!customer?.id) return null;

    const fullName = (customer.fullName ?? '').trim() || null;
    const name = fullName ? fullName.split(/\s+/)[0] : null;
    const vkUserId = customer.vk?.id ? String(customer.vk.id) : null;
    const vkDialogUrl = this.buildVkDialogUrl(customer);
    const crmStatus = customer.crmStatus?.name ?? null;
    const firstContactAt = this.extractCustomerFirstContactAt(customer);
    const source = this.extractCustomerSource(customer);
    const marks = this.extractCustomerMarks(customer);

    const lead = await this.prisma.lead.upsert({
      where: { bsCustomerId: customer.id },
      create: {
        bsCustomerId: customer.id,
        name,
        fullName,
        vkUserId,
        vkDialogUrl,
        firstContactAt,
        source,
        marks,
        crmStatus,
        lastSyncedAt: new Date(),
      },
      update: {
        name,
        fullName,
        vkUserId,
        vkDialogUrl,
        firstContactAt,
        source,
        marks,
        crmStatus,
        lastSyncedAt: new Date(),
      },
    });
    return lead.id;
  }

  async upsertOrder(bsOrder: BsOrder, leadId: number | null): Promise<void> {
    const orderNumber = this.resolveOrderNumber(bsOrder);
    const title = `Заказ номер ${orderNumber}`;
    const bsCreatedAt = this.parseDate(bsOrder.date);
    const crm = bsOrder.customer?.crmStatus ?? null;

    // Менеджер ведения — менеджер клиента в BlueSales.
    const deliveryManagerName = this.resolveDeliveryManagerName(bsOrder);
    // Менеджер оформления — кастомное поле заказа «Оформление».
    const onboardingManagerName = this.resolveOnboardingManagerName(bsOrder);

    const infoData = {
      bsCustomerId: bsOrder.customer?.id ?? null,
      bsNumber: orderNumber,
      orderStatusId: bsOrder.orderStatus?.id ?? null,
      orderStatus: bsOrder.orderStatus?.name ?? null,
      crmStatusId: crm?.id ?? null,
      crmStatus: crm?.name ?? null,
      totalSum: bsOrder.totalSumMinusDiscount ?? null,
      prepaymentSum: this.extractPrepaymentSum(bsOrder),
      bsCreatedAt,
      rawPayload: bsOrder as unknown as Prisma.InputJsonValue,
      lastSyncedAt: new Date(),
    };

    const managerData = { deliveryManagerName, onboardingManagerName };

    const existing = await this.prisma.bluesalesOrderInfo.findUnique({
      where: { bsOrderId: bsOrder.id },
    });

    if (existing) {
      await this.prisma.$transaction([
        this.prisma.bluesalesOrderInfo.update({
          where: { bsOrderId: bsOrder.id },
          data: infoData,
        }),
        this.prisma.order.update({
          where: { id: existing.orderId },
          data: { ...managerData, ...(leadId ? { leadId } : {}) },
        }),
      ]);
      return;
    }

    const sameNumber = await this.prisma.order.findUnique({ where: { orderNumber } });
    if (sameNumber) {
      await this.prisma.bluesalesOrderInfo.create({
        data: { ...infoData, bsOrderId: bsOrder.id, orderId: sameNumber.id },
      });
      await this.prisma.order.update({
        where: { id: sameNumber.id },
        data: {
          ...managerData,
          ...(leadId && sameNumber.leadId !== leadId ? { leadId } : {}),
        },
      });
      return;
    }

    await this.prisma.order.create({
      data: {
        orderNumber,
        title,
        source: OrderSource.BLUESALES,
        leadId: leadId ?? undefined,
        ...managerData,
        bluesalesInfo: { create: { ...infoData, bsOrderId: bsOrder.id } },
      },
    });
  }

  // ─── Вспомогательные методы ───────────────────────────────────────────────

  /** Менеджер ведения = менеджер клиента в BlueSales (customer.manager). */
  private resolveDeliveryManagerName(bsOrder: BsOrder): string | null {
    const name = bsOrder.customer?.manager?.fullName ?? bsOrder.manager?.fullName;
    const trimmed = (name ?? '').trim();
    return trimmed.length > 0 ? trimmed : null;
  }

  /** Менеджер оформления = кастомное поле заказа «Оформление». */
  private resolveOnboardingManagerName(bsOrder: BsOrder): string | null {
    const field = (bsOrder.customFields ?? []).find(
      (f) => (f.fieldName ?? '').trim().toLowerCase() === 'оформление',
    );
    const trimmed = (field?.valueAsText ?? '').trim();
    return trimmed.length > 0 ? trimmed : null;
  }

  private resolveOrderNumber(bsOrder: BsOrder): string {
    const candidate =
      this.firstNonEmpty(bsOrder.internalNumber, bsOrder.externalNumber) ?? bsOrder.id;
    return String(candidate);
  }

  private firstNonEmpty(
    ...values: Array<number | string | null | undefined>
  ): number | string | null {
    for (const v of values) {
      if (v !== null && v !== undefined && String(v).trim() !== '') return v;
    }
    return null;
  }

  private extractCustomerFirstContactAt(customer: BsCustomer): Date | null {
    const value = this.pickString(
      customer['firstContactDate'],
      customer['dateFirstContact'],
      customer['firstContactAt'],
      customer['createdAt'],
      customer['creationDate'],
    );
    return this.parseDate(value);
  }

  private extractCustomerSource(customer: BsCustomer): string | null {
    const salesChannel = customer.salesChannel?.name;
    const direct = this.pickString(
      customer['source'],
      customer['sourceName'],
      customer['leadSource'],
      customer['channel'],
    );
    return this.pickString(salesChannel, direct);
  }

  private extractCustomerMarks(customer: BsCustomer): string | null {
    const direct = customer['marks'] ?? customer['mark'] ?? customer['notes'] ?? customer['note'];
    if (typeof direct === 'string') {
      const trimmed = direct.trim();
      return trimmed.length > 0 ? trimmed : null;
    }
    if (Array.isArray(direct)) {
      const rendered = direct
        .map((item) => (typeof item === 'string' ? item.trim() : String(item ?? '').trim()))
        .filter((item) => item.length > 0)
        .join(', ');
      return rendered.length > 0 ? rendered : null;
    }
    return null;
  }

  private extractPrepaymentSum(bsOrder: BsOrder): number | null {
    const candidate = this.pickNumber(
      bsOrder['prepaymentSum'],
      bsOrder['prepaidSum'],
      bsOrder['advanceSum'],
      bsOrder['downPaymentSum'],
      bsOrder['totalPrepayment'],
    );
    if (candidate !== null) return candidate;

    const fromCustomFields = (bsOrder.customFields ?? []).find((field) =>
      (field.fieldName ?? '').toLowerCase().includes('предоплат'),
    );
    return this.pickNumber(fromCustomFields?.value, fromCustomFields?.valueAsText);
  }

  private pickString(...values: unknown[]): string | null {
    for (const value of values) {
      if (typeof value !== 'string') continue;
      const trimmed = value.trim();
      if (trimmed.length > 0) return trimmed;
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

  private buildVkDialogUrl(customer: BsCustomer): string | null {
    const userId = customer.vk?.id ? String(customer.vk.id) : null;
    if (!userId) return null;
    const groupId = customer.vk?.messagesGroupId
      ? String(customer.vk.messagesGroupId)
      : this.vkGroupId || null;
    if (!groupId) return null;
    return `https://vk.com/gim${groupId}?sel=${userId}`;
  }

  /** BlueSales отдаёт даты как "DD.MM.YYYY" (опц. " HH:mm:ss"). */
  private parseDate(value?: string | null): Date | null {
    if (!value) return null;
    const match = value.match(
      /^(\d{2})\.(\d{2})\.(\d{4})(?:\s+(\d{2}):(\d{2})(?::(\d{2}))?)?$/,
    );
    if (match) {
      const [, dd, mm, yyyy, hh = '0', min = '0', ss = '0'] = match;
      const parsed = new Date(
        Date.UTC(Number(yyyy), Number(mm) - 1, Number(dd), Number(hh), Number(min), Number(ss)),
      );
      return Number.isNaN(parsed.getTime()) ? null : parsed;
    }
    const fallback = new Date(value);
    return Number.isNaN(fallback.getTime()) ? null : fallback;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private formatDuration(ms: number): string {
    const totalSeconds = Math.max(0, Math.floor(ms / 1000));
    const days = Math.floor(totalSeconds / 86_400);
    const hours = Math.floor((totalSeconds % 86_400) / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;

    if (days > 0) return `${days}д ${hours}ч`;
    if (hours > 0) return `${hours}ч ${minutes}м`;
    if (minutes > 0) return `${minutes}м ${seconds}с`;
    return `${seconds}с`;
  }

  private async markRun(key: string): Promise<void> {
    await this.prisma.syncState.upsert({
      where: { key },
      create: { key, lastRunAt: new Date() },
      update: { lastRunAt: new Date(), lastError: null },
    });
  }

  private async markSuccess(key: string, itemsSynced: number): Promise<void> {
    await this.prisma.syncState.update({
      where: { key },
      data: { lastSuccessAt: new Date(), itemsSynced, lastError: null },
    });
  }

  private async markError(key: string, message: string): Promise<void> {
    await this.prisma.syncState.upsert({
      where: { key },
      create: { key, lastError: message },
      update: { lastError: message },
    });
  }
}
