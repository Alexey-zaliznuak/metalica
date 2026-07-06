import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { OrderSource, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { BluesalesApiService, BsCustomer, BsOrder } from './bluesales-api.service';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Cron быстрого инкрементального синка. Переопределяется через
 * BLUESALES_FAST_SYNC_CRON (читается на этапе загрузки модуля).
 */
const FAST_SYNC_CRON = process.env.BLUESALES_FAST_SYNC_CRON ?? '*/5 * * * *';

@Injectable()
export class BluesalesSyncService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(BluesalesSyncService.name);
  private readonly enabled: boolean;
  private readonly vkGroupId: string;

  // ─── Параметры синка (все из env, значения ниже — дефолты) ────────────────
  /** Выполнить полный синк заказов и лидов за период при старте бэка. */
  private readonly fullSyncOnStartup: boolean;
  /** Период полного синка в днях (заказы + лиды). */
  private readonly fullSyncDays: number;
  /** Размер окна (в днях) при полном синке — дробим период, чтобы не грузить BS API. */
  private readonly fullSyncWindowDays: number;
  /** Перекрытие окна быстрого синка (мин), чтобы не терять заказы на границе. */
  private readonly fastSyncOverlapMinutes: number;
  /** Размер пачки заказов в refresh-loop. */
  private readonly refreshBatchSize: number;
  /** Пауза между итерациями refresh-loop заказов (мс). */
  private readonly refreshPauseMs: number;
  /** Refresh-loop обновляет заказы не старше стольких дней. */
  private readonly refreshLookbackDays: number;
  /** Размер пачки лидов в refresh-loop лидов. */
  private readonly leadsRefreshBatchSize: number;
  /** Пауза между итерациями loop'а лидов (мс). */
  private readonly leadsPauseMs: number;
  /** Refresh-loop лидов обновляет только тех, у кого последний контакт за N дней. */
  private readonly leadsRefreshLookbackDays: number;

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

    this.fullSyncOnStartup = this.envBool('BLUESALES_FULL_SYNC', false);
    this.fullSyncDays = this.envInt('BLUESALES_SYNC_DAYS', 7);
    this.fullSyncWindowDays = this.envInt('BLUESALES_FULL_SYNC_WINDOW_DAYS', 7);
    this.fastSyncOverlapMinutes = this.envInt('BLUESALES_FAST_SYNC_OVERLAP_MINUTES', 70);
    this.refreshBatchSize = this.envInt('BLUESALES_REFRESH_BATCH_SIZE', 50);
    this.refreshPauseMs = this.envInt('BLUESALES_REFRESH_PAUSE_MS', 3000);
    this.refreshLookbackDays = this.envInt('BLUESALES_REFRESH_LOOKBACK_DAYS', 60);
    this.leadsRefreshBatchSize = this.envInt('BLUESALES_LEADS_REFRESH_BATCH_SIZE', 50);
    this.leadsPauseMs = this.envInt('BLUESALES_LEADS_PAUSE_MS', 3000);
    this.leadsRefreshLookbackDays = this.envInt('BLUESALES_LEADS_REFRESH_LOOKBACK_DAYS', 60);
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
    this.logger.log(
      `BlueSales sync активен: cron "${FAST_SYNC_CRON}" + refresh-loop заказов + loop лидов` +
        (this.fullSyncOnStartup ? ` + полный синк при старте за ${this.fullSyncDays} дн.` : ''),
    );
    this.loopActive = true;
    // Запускаем циклы после небольшой паузы, чтобы приложение успело подняться.
    setTimeout(() => void this.runRefreshLoop(), 5000);
    setTimeout(() => void this.runLeadsLoop(), 8000);
    // Полный синк за период выполняется один раз при старте, если включён через env.
    if (this.fullSyncOnStartup) {
      setTimeout(() => void this.runFullSync(), 11000);
    }
  }

  onModuleDestroy(): void {
    this.loopActive = false;
  }

  private envInt(key: string, def: number): number {
    const raw = this.config.get<string>(key);
    const n = raw != null && raw !== '' ? Number(raw) : NaN;
    return Number.isFinite(n) && n > 0 ? n : def;
  }

  private envBool(key: string, def: boolean): boolean {
    const raw = this.config.get<string>(key);
    if (raw == null || raw === '') return def;
    return raw === 'true' || raw === '1';
  }

  // ─── Быстрый инкрементальный синк (каждые 5 минут) ────────────────────────

  /**
   * По cron тянет заказы за последние ~N минут (перекрытие) и досоздаёт новые,
   * а также инкрементально подтягивает новых/активных лидов по дате последнего
   * контакта (в т.ч. тех, у кого ещё нет заказа).
   * Перекрытие исключает пропуск записей на границе интервалов.
   */
  @Cron(FAST_SYNC_CRON)
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
    } finally {
      this.fastSyncRunning = false;
    }
  }

  async runFastSync(): Promise<{ orders: number; leads: number }> {
    const now = new Date();
    const dateFrom = new Date(now.getTime() - this.fastSyncOverlapMinutes * 60 * 1000);

    const bsOrders = await this.api.getOrders(dateFrom, now);

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

    // Инкрементальный синк новых/активных лидов по дате последнего контакта.
    // Ловит тех, кто написал, но заказ ещё не оформил (синк заказов их не видит).
    // BS фильтрует даты с точностью до дня, поэтому окно перекрытия фактически
    // охватывает текущий (и при переходе через полночь — вчерашний) день.
    const newLeads = await this.syncRecentLeads(dateFrom, now);

    this.logger.log(
      `Быстрый синк BS: заказов ${synced}/${bsOrders.length}, ` +
        `лидов из заказов ${leadIds.size}, новых/активных лидов ${newLeads}`,
    );
    return { orders: synced, leads: leadIds.size + newLeads };
  }

  /** Инкрементальный синк лидов по дате последнего контакта за окно [from, to]. */
  private async syncRecentLeads(from: Date, to: Date): Promise<number> {
    const customers = await this.api.getCustomers({
      lastContactFrom: from,
      lastContactTo: to,
    });
    return this.upsertLeads(customers);
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
      }

      // Пауза даёт другим запросам к BS API (от менеджеров) попасть в очередь.
      await this.sleep(this.refreshPauseMs);
    }

    this.logger.log('Фоновый refresh-loop остановлен');
  }

  private async refreshBatch(): Promise<void> {
    // Засекаем время именно одной итерации: выборка из БД + запрос в BS + upsert в нашу БД.
    const startedAt = Date.now();

    // Refresh-loop не трогает старые архивные заказы: обновляем только заказы
    // с датой создания в BS не старше refreshLookbackDays.
    const lookbackDate = new Date(Date.now() - this.refreshLookbackDays * DAY_MS);

    // Берём небольшую пачку заказов, которые дольше всего не обновлялись.
    // lastSyncedAt обновляется после каждого успешного upsert, поэтому такая сортировка
    // равномерно "прокручивает" все актуальные заказы по кругу.
    const batch = await this.prisma.bluesalesOrderInfo.findMany({
      where: {
        bsCreatedAt: { gte: lookbackDate },
      },
      orderBy: { lastSyncedAt: 'asc' },
      take: this.refreshBatchSize,
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

    // Один лёгкий запрос к BlueSales по ids вместо тяжёлой выгрузки за период.
    // Внутри api.getOrdersByIds всё равно используется общий mutex, поэтому
    // параллельных запросов к BS из нашего бэкенда не будет.
    // Отдельно засекаем время самого запроса к BS (без учёта upsert в нашу БД).
    const apiStartedAt = Date.now();
    const bsOrders = await this.api.getOrdersByIds(ids);
    const apiMs = Date.now() - apiStartedAt;

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

    // Логируем длительность пачки, чтобы видеть, сколько времени API BS и upsert
    // реально занимают на refreshBatchSize заказов.
    const elapsedMs = Date.now() - startedAt;
    this.logger.debug(
      `Refresh-loop: обновлено ${synced}, пропущено (нет в BS) ${missingIds.length}, ` +
        `время запроса ${apiMs} мс, время батча ${elapsedMs} мс, лаг старейшего ${this.formatDuration(oldestSyncLagMs)}`,
    );
  }

  // ─── Полный синк за период (по env, разово при старте) ────────────────────

  /**
   * Разовый полный синк заказов и лидов за последние {@link fullSyncDays} дней.
   * Запускается при старте, если включён BLUESALES_FULL_SYNC. Период дробится на
   * окна по {@link fullSyncWindowDays} дней с паузами, чтобы не монополизировать
   * единственную сессию BlueSales (её делят refresh-loop и запросы менеджеров).
   */
  private async runFullSync(): Promise<void> {
    const now = new Date();
    const from = new Date(now.getTime() - this.fullSyncDays * DAY_MS);
    this.logger.log(
      `Полный синк при старте: заказы + лиды с ${this.formatDate(from)} по ${this.formatDate(now)}`,
    );

    let orders = 0;
    let leads = 0;
    let windowTo = now;

    while (this.loopActive && windowTo.getTime() > from.getTime()) {
      const windowFrom = new Date(
        Math.max(from.getTime(), windowTo.getTime() - this.fullSyncWindowDays * DAY_MS),
      );
      try {
        orders += await this.syncOrdersWindow(windowFrom, windowTo);
        leads += await this.syncLeadsWindow(windowFrom, windowTo);
      } catch (err) {
        this.logger.error(
          `Полный синк: окно ${this.formatDate(windowFrom)}…${this.formatDate(windowTo)} ошибка: ${(err as Error).message}`,
        );
      }
      windowTo = windowFrom;
      await this.sleep(this.refreshPauseMs);
    }

    this.logger.log(`Полный синк завершён: заказов ${orders}, лидов ${leads}`);
  }

  /** Синк всех заказов за окно [from, to] (вместе с их лидами). */
  private async syncOrdersWindow(from: Date, to: Date): Promise<number> {
    const bsOrders = await this.api.getOrders(from, to);
    let synced = 0;
    for (const bsOrder of bsOrders) {
      try {
        const leadId = await this.upsertLead(bsOrder.customer ?? null);
        await this.upsertOrder(bsOrder, leadId);
        synced++;
      } catch (err) {
        this.logger.error(
          `Полный синк заказов: не удалось обработать BS#${bsOrder.id}: ${(err as Error).message}`,
        );
      }
    }
    this.logger.debug(
      `Полный синк заказов: окно ${this.formatDate(from)}…${this.formatDate(to)}, ` +
        `заказов ${synced}/${bsOrders.length}`,
    );
    return synced;
  }

  /** Синк всех лидов, созданных в окно [from, to] (по дате первого контакта). */
  private async syncLeadsWindow(from: Date, to: Date): Promise<number> {
    const customers = await this.api.getCustomers({ firstContactFrom: from, firstContactTo: to });
    const synced = await this.upsertLeads(customers);
    this.logger.debug(
      `Полный синк лидов: окно ${this.formatDate(from)}…${this.formatDate(to)}, ` +
        `лидов ${synced}/${customers.length}`,
    );
    return synced;
  }

  // ─── Синк лидов (клиентов) ────────────────────────────────────────────────

  /**
   * Постоянный refresh-loop лидов «по id» — так же, как refresh-loop заказов.
   * Берёт из нашей БД пачку {@link leadsRefreshBatchSize} лидов, у которых
   * последний контакт был не позже {@link leadsRefreshLookbackDays} дней назад
   * (сортировка по lastSyncedAt asc — прокручиваем «живых» лидов по кругу),
   * и актуализирует их одним запросом customers.get по ids.
   *
   * Исторические и новые лиды попадают в БД через полный синк (см. {@link runFullSync})
   * и синк заказов (customer приходит вместе с заказом).
   */
  private async runLeadsLoop(): Promise<void> {
    this.logger.log('Loop лидов (refresh по id) запущен');

    while (this.loopActive) {
      try {
        await this.refreshLeadsBatch();
      } catch (err) {
        this.logger.error(`Loop лидов ошибка: ${(err as Error).message}`);
      }
      await this.sleep(this.leadsPauseMs);
    }

    this.logger.log('Loop лидов остановлен');
  }

  /** Один шаг refresh-loop лидов: батч «живых» лидов из БД, обновление по ids. */
  private async refreshLeadsBatch(): Promise<void> {
    const startedAt = Date.now();
    const lookbackDate = new Date(Date.now() - this.leadsRefreshLookbackDays * DAY_MS);

    // Обновляем только «живых» лидов: последний контакт не старше lookback.
    // Сортировка по lastSyncedAt asc равномерно прокручивает их по кругу.
    const batch = await this.prisma.lead.findMany({
      where: {
        bsCustomerId: { not: null },
        lastContactAt: { gte: lookbackDate },
      },
      orderBy: { lastSyncedAt: 'asc' },
      take: this.leadsRefreshBatchSize,
      select: { bsCustomerId: true, lastSyncedAt: true },
    });

    if (batch.length === 0) {
      // Нет «живых» лидов для обновления — ждём подольше, чтобы не спамить в БД.
      await this.sleep(10_000);
      return;
    }

    const ids = batch
      .map((b) => b.bsCustomerId)
      .filter((id): id is number => id != null);
    const oldestSyncLagMs = startedAt - batch[0].lastSyncedAt.getTime();

    // Отдельно засекаем время самого запроса к BS (без учёта upsert в нашу БД).
    const apiStartedAt = Date.now();
    const customers = await this.api.getCustomersByIds(ids);
    const apiMs = Date.now() - apiStartedAt;

    const returnedIds = new Set(customers.map((c) => c.id));
    const synced = await this.upsertLeads(customers);

    // Лиды, которых BS не вернул (удалены/недоступны), всё равно двигаем по очереди.
    const missingIds = ids.filter((id) => !returnedIds.has(id));
    if (missingIds.length > 0) {
      await this.prisma.lead.updateMany({
        where: { bsCustomerId: { in: missingIds } },
        data: { lastSyncedAt: new Date() },
      });
    }

    const elapsedMs = Date.now() - startedAt;
    this.logger.debug(
      `Refresh лидов: обновлено ${synced}, пропущено (нет в BS) ${missingIds.length}, ` +
        `время запроса ${apiMs} мс, время батча ${elapsedMs} мс, лаг старейшего ${this.formatDuration(oldestSyncLagMs)}`,
    );
  }

  /** Upsert пачки клиентов в лиды; возвращает число успешно обработанных. */
  private async upsertLeads(customers: BsCustomer[]): Promise<number> {
    let synced = 0;
    for (const customer of customers) {
      try {
        const leadId = await this.upsertLead(customer);
        if (leadId) synced++;
      } catch (err) {
        this.logger.error(
          `Синк лидов: не удалось обработать клиента #${customer?.id}: ${(err as Error).message}`,
        );
      }
    }
    return synced;
  }

  private formatDate(date: Date): string {
    const y = date.getUTCFullYear();
    const m = `${date.getUTCMonth() + 1}`.padStart(2, '0');
    const d = `${date.getUTCDate()}`.padStart(2, '0');
    return `${y}-${m}-${d}`;
  }

  // ─── Upsert-логика (общая для обоих процессов) ────────────────────────────

  async upsertLead(customer: BsCustomer | null): Promise<number | null> {
    if (!customer?.id) return null;

    const fullName = (customer.fullName ?? '').trim() || null;
    const name = fullName ? fullName.split(/\s+/)[0] : null;
    // Менеджер клиента в BlueSales (customer.manager): имя + BS-id.
    const managerName = (customer.manager?.fullName ?? '').trim() || null;
    const managerId =
      typeof customer.manager?.id === 'number' ? customer.manager.id : null;
    const vkUserId = customer.vk?.id ? String(customer.vk.id) : null;
    const vkDialogUrl = this.buildVkDialogUrl(customer);
    const crmStatus = customer.crmStatus?.name ?? null;
    const firstContactAt = this.extractCustomerFirstContactAt(customer);
    const lastContactAt = this.extractCustomerLastContactAt(customer);
    // Источник и канал продаж храним по ID (как теги); имена — в справочниках.
    const sourcePair = this.extractCustomerSourcePair(customer);
    const salesChannelPair = this.extractCustomerSalesChannelPair(customer);
    const source = sourcePair?.bsSourceId ?? null;
    const salesChannel = salesChannelPair?.bsSalesChannelId ?? null;
    const marks = this.extractCustomerMarks(customer);
    const tags = this.extractCustomerTagIds(customer);
    const tagPairs = this.extractCustomerTagPairs(customer);

    const lead = await this.prisma.lead.upsert({
      where: { bsCustomerId: customer.id },
      create: {
        bsCustomerId: customer.id,
        name,
        fullName,
        managerName,
        managerId,
        vkUserId,
        vkDialogUrl,
        firstContactAt,
        lastContactAt,
        source,
        salesChannel,
        marks,
        tags,
        crmStatus,
        lastSyncedAt: new Date(),
      },
      update: {
        name,
        fullName,
        managerName,
        managerId,
        vkUserId,
        vkDialogUrl,
        firstContactAt,
        lastContactAt,
        source,
        salesChannel,
        marks,
        tags,
        crmStatus,
        lastSyncedAt: new Date(),
      },
    });

    // Актуализируем справочники имён (id -> name) при каждом обновлении лида.
    await this.upsertTagNames(tagPairs);
    await this.upsertSourceName(sourcePair);
    await this.upsertSalesChannelName(salesChannelPair);

    return lead.id;
  }

  /** Актуализирует справочник имён источников BlueSales (bsSourceId -> name). */
  private async upsertSourceName(
    pair: { bsSourceId: string; name: string } | null,
  ): Promise<void> {
    if (!pair) return;
    await this.prisma.bluesalesSource.upsert({
      where: { bsSourceId: pair.bsSourceId },
      create: { bsSourceId: pair.bsSourceId, name: pair.name },
      update: { name: pair.name },
    });
  }

  /** Актуализирует справочник имён каналов продаж BlueSales (bsSalesChannelId -> name). */
  private async upsertSalesChannelName(
    pair: { bsSalesChannelId: string; name: string } | null,
  ): Promise<void> {
    if (!pair) return;
    await this.prisma.bluesalesSalesChannel.upsert({
      where: { bsSalesChannelId: pair.bsSalesChannelId },
      create: { bsSalesChannelId: pair.bsSalesChannelId, name: pair.name },
      update: { name: pair.name },
    });
  }

  /** Актуализирует справочник имён тегов BlueSales (bsTagId -> name). */
  private async upsertTagNames(pairs: Array<{ bsTagId: string; name: string }>): Promise<void> {
    for (const { bsTagId, name } of pairs) {
      await this.prisma.bluesalesTag.upsert({
        where: { bsTagId },
        create: { bsTagId, name },
        update: { name },
      });
    }
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

  private extractCustomerLastContactAt(customer: BsCustomer): Date | null {
    const value = this.pickString(
      customer['lastContactDate'],
      customer['dateLastContact'],
      customer['lastContactAt'],
      customer['lastActivityDate'],
    );
    return this.parseDate(value);
  }

  /**
   * «Источник» клиента в BlueSales — объект { id, name } (напр. { 237408, "avito" }).
   * Возвращает пару {bsSourceId, name} для лида и справочника, либо null.
   */
  private extractCustomerSourcePair(
    customer: BsCustomer,
  ): { bsSourceId: string; name: string } | null {
    const id = customer.source?.id;
    const name = (customer.source?.name ?? '').trim();
    if (id == null || !name) return null;
    return { bsSourceId: String(id), name };
  }

  /**
   * «Канал продаж» клиента в BlueSales — объект { id, name } (напр. { 194834, "ВКонтакте" }).
   * Возвращает пару {bsSalesChannelId, name} для лида и справочника, либо null.
   */
  private extractCustomerSalesChannelPair(
    customer: BsCustomer,
  ): { bsSalesChannelId: string; name: string } | null {
    const id = customer.salesChannel?.id;
    const name = (customer.salesChannel?.name ?? '').trim();
    if (id == null || !name) return null;
    return { bsSalesChannelId: String(id), name };
  }

  /** «Отметки» клиента в BlueSales — простая строка в поле shortNotes. */
  private extractCustomerMarks(customer: BsCustomer): string | null {
    const direct =
      customer['shortNotes'] ??
      customer['marks'] ??
      customer['mark'] ??
      customer['notes'] ??
      customer['note'];
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

  /** «Теги» клиента в BlueSales — список ID (tags[].id). */
  private extractCustomerTagIds(customer: BsCustomer): string[] {
    const tags = customer.tags;
    if (!Array.isArray(tags)) return [];
    const ids = tags
      .map((tag) => (tag && typeof tag === 'object' && tag.id != null ? String(tag.id) : ''))
      .filter((id) => id.length > 0);
    return [...new Set(ids)];
  }

  /** Пары {bsTagId, name} для справочника BluesalesTag. */
  private extractCustomerTagPairs(
    customer: BsCustomer,
  ): Array<{ bsTagId: string; name: string }> {
    const tags = customer.tags;
    if (!Array.isArray(tags)) return [];
    const pairs: Array<{ bsTagId: string; name: string }> = [];
    for (const tag of tags) {
      if (!tag || typeof tag !== 'object' || tag.id == null) continue;
      const name = (tag.name ?? '').trim();
      if (!name) continue;
      pairs.push({ bsTagId: String(tag.id), name });
    }
    return pairs;
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
}
