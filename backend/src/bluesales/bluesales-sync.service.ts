import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { OrderSource, OrderStatusChangeState, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { BluesalesApiService, BsCustomer, BsOrder } from './bluesales-api.service';
import {
  computeSketchTimestampUpdate,
  isSketchTrackedStatus,
  SKETCH_READY_STATUS,
  SKETCH_START_STATUS,
  SketchTimestamps,
} from '../orders/sketch-status';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Cron быстрого инкрементального синка. Переопределяется через
 * BLUESALES_FAST_SYNC_CRON (читается на этапе загрузки модуля).
 */
const FAST_SYNC_CRON = process.env.BLUESALES_FAST_SYNC_CRON ?? '*/5 * * * *';

/**
 * Cron периодического добора «потеряшек» — заказов и лидов за последние
 * несколько дней по дате создания / первого контакта. Переопределяется через
 * BLUESALES_BACKFILL_CRON (читается на этапе загрузки модуля).
 */
const BACKFILL_CRON = process.env.BLUESALES_BACKFILL_CRON ?? '0 * * * *';

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
  /** Периодический добор новых лидов за столько последних дней (включая сегодня). */
  private readonly backfillDays: number;
  /** Размер пачки в фоновом бэкфилле меток эскиза. */
  private readonly sketchBackfillBatchSize: number;
  /** Пауза между итерациями бэкфилла меток эскиза, когда работы нет (мс). */
  private readonly sketchBackfillIdleMs: number;

  /** Защита от параллельного запуска быстрого синка. */
  private fastSyncRunning = false;
  /** Защита от параллельного запуска периодического добора. */
  private backfillRunning = false;
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
    // 2 = сегодня + вчера. Запас во «вчера» страхует от рассинхрона границы суток
    // (BS фильтрует по дню в МСК, а formatDate считает день по UTC).
    this.backfillDays = this.envInt('BLUESALES_BACKFILL_DAYS', 2);
    this.sketchBackfillBatchSize = this.envInt('SKETCH_BACKFILL_BATCH_SIZE', 500);
    this.sketchBackfillIdleMs = this.envInt('SKETCH_BACKFILL_IDLE_MS', 60000);
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
        ` + backfill "${BACKFILL_CRON}" за ${this.backfillDays} дн.` +
        (this.fullSyncOnStartup ? ` + полный синк при старте за ${this.fullSyncDays} дн.` : ''),
    );
    this.loopActive = true;
    // Запускаем циклы после небольшой паузы, чтобы приложение успело подняться.
    setTimeout(() => void this.runRefreshLoop(), 5000);
    setTimeout(() => void this.runLeadsLoop(), 8000);
    // Фоновый бэкфилл меток эскиза (только по БД, без запросов в BlueSales).
    setTimeout(() => void this.runSketchBackfillLoop(), 6000);
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
    const statusObservedAt = new Date();

    const leadIds = new Set<number>();
    let synced = 0;

    const existingInfos = await this.prisma.bluesalesOrderInfo.findMany({
      where: { bsOrderId: { in: bsOrders.map((o) => o.id) } },
      select: { bsOrderId: true, orderId: true },
    });
    const existingByBsId = new Map(existingInfos.map((info) => [info.bsOrderId, info]));

    await this.syncReferenceDictionaries(bsOrders.map((o) => o.customer ?? null));

    for (const bsOrder of bsOrders) {
      try {
        const leadId = await this.upsertLead(bsOrder.customer ?? null, false);
        if (leadId) leadIds.add(leadId);
        await this.upsertOrder(
          bsOrder,
          leadId,
          existingByBsId.get(bsOrder.id) ?? null,
          statusObservedAt,
        );
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

  // ─── Периодический добор «потеряшек» (раз в час) ──────────────────────────

  /**
   * По cron добирает заказы и лидов за последние {@link backfillDays} дней
   * (по дате создания заказа / первого контакта лида). Закрывает записи, которые
   * пропустил быстрый синк из-за простоя бэка, ошибок BS API или рассинхрона
   * границы суток: инкрементальный синк ищет лидов только по дате последнего
   * контакта в узком скользящем окне, поэтому «потеряшки» иначе не восстановятся.
   */
  @Cron(BACKFILL_CRON)
  async handleRecentBackfill(): Promise<void> {
    if (!this.enabled || !this.api.isConfigured) return;
    if (this.backfillRunning) {
      this.logger.debug('Добор новых лидов ещё выполняется — пропуск');
      return;
    }
    this.backfillRunning = true;
    try {
      await this.runRecentBackfill();
    } catch (err) {
      this.logger.error(`Добор новых лидов ошибка: ${(err as Error).message}`);
    } finally {
      this.backfillRunning = false;
    }
  }

  /**
   * Проходит последние {@link backfillDays} дней отдельными однодневными окнами
   * (сегодня, вчера, …) с паузой между ними. Однодневные окна дают лёгкие запросы
   * к BS (страницы по 500 за один день), а background-приоритет в очереди API
   * пропускает вперёд интерактивные запросы менеджеров.
   */
  private async runRecentBackfill(): Promise<{ orders: number; leads: number }> {
    const now = new Date();
    let orders = 0;
    let leads = 0;

    for (let i = 0; i < this.backfillDays && this.loopActive; i++) {
      const day = new Date(now.getTime() - i * DAY_MS);
      try {
        orders += await this.syncOrdersWindow(day, day);
        leads += await this.syncLeadsWindow(day, day);
      } catch (err) {
        this.logger.error(
          `Добор: день ${this.formatDate(day)} ошибка: ${(err as Error).message}`,
        );
      }
      // Пауза между днями — не монополизируем единственную сессию BlueSales.
      await this.sleep(this.refreshPauseMs);
    }

    this.logger.log(`Добор новых лидов за ${this.backfillDays} дн.: заказов ${orders}, лидов ${leads}`);
    return { orders, leads };
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
    const statusObservedAt = new Date();
    const apiMs = Date.now() - apiStartedAt;

    // Нужно понять, какие id BlueSales вернул. Если какого-то id нет в ответе,
    // это может означать удаление/недоступность заказа; обработаем это ниже.
    const returnedIds = new Set(bsOrders.map((o) => o.id));
    let synced = 0;

    // Одним запросом подтягиваем orderId для всех заказов батча (вместо findUnique
    // на каждый заказ внутри upsertOrder).
    const existingInfos = await this.prisma.bluesalesOrderInfo.findMany({
      where: { bsOrderId: { in: bsOrders.map((o) => o.id) } },
      select: { bsOrderId: true, orderId: true },
    });
    const existingByBsId = new Map(existingInfos.map((info) => [info.bsOrderId, info]));

    // Справочники имён (source/salesChannel/tags) обновляем один раз на весь батч.
    await this.syncReferenceDictionaries(bsOrders.map((o) => o.customer ?? null));

    for (const bsOrder of bsOrders) {
      try {
        // В ответе заказа лежит customer, поэтому обновляем лида и сам заказ вместе.
        // upsertOrder также обновит BluesalesOrderInfo.lastSyncedAt.
        const leadId = await this.upsertLead(bsOrder.customer ?? null, false);
        await this.upsertOrder(
          bsOrder,
          leadId,
          existingByBsId.get(bsOrder.id) ?? null,
          statusObservedAt,
        );
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

  // ─── Фоновый бэкфилл меток эскиза ──────────────────────────────────────────

  /**
   * Бесконечный цикл, который проставляет метки времени эскиза заказам, уже
   * находящимся в соответствующем статусе, но без метки. Работает только по нашей
   * БД (без запросов в BlueSales):
   *  - заказ в статусе «Готовим эскиз» без sketchStartedAt -> ставим sketchStartedAt;
   *  - заказ в статусе «Эскиз готов» без sketchReadyAt      -> ставим sketchReadyAt.
   *
   * Служит первичным бэкфиллом исторических заказов и страховкой на случай, если
   * быстрый синк «проскочил» момент смены статуса между итерациями.
   *
   * Метки выставляются моментом обнаружения (now), т.к. реальное время входа в
   * статус для уже находящихся в нём заказов неизвестно.
   */
  private async runSketchBackfillLoop(): Promise<void> {
    this.logger.log('Фоновый sketch-backfill loop запущен');

    while (this.loopActive) {
      let updated = 0;
      try {
        updated = await this.sketchBackfillBatch();
      } catch (err) {
        this.logger.error(`Sketch-backfill loop ошибка: ${(err as Error).message}`);
      }
      // Есть работа — продолжаем быстро (могут быть ещё батчи), иначе ждём подольше.
      await this.sleep(updated > 0 ? this.refreshPauseMs : this.sketchBackfillIdleMs);
    }

    this.logger.log('Фоновый sketch-backfill loop остановлен');
  }

  /** Одна итерация бэкфилла меток эскиза. Возвращает число проставленных меток. */
  private async sketchBackfillBatch(): Promise<number> {
    const now = new Date();

    const [needStart, needReady] = await Promise.all([
      this.prisma.order.findMany({
        where: {
          sketchStartedAt: null,
          bluesalesInfo: {
            is: { orderStatus: { equals: SKETCH_START_STATUS, mode: 'insensitive' } },
          },
        },
        select: { id: true },
        take: this.sketchBackfillBatchSize,
      }),
      this.prisma.order.findMany({
        where: {
          sketchReadyAt: null,
          bluesalesInfo: {
            is: { orderStatus: { equals: SKETCH_READY_STATUS, mode: 'insensitive' } },
          },
        },
        select: { id: true },
        take: this.sketchBackfillBatchSize,
      }),
    ]);

    let updated = 0;
    if (needStart.length > 0) {
      const res = await this.prisma.order.updateMany({
        where: { id: { in: needStart.map((o) => o.id) } },
        data: { sketchStartedAt: now },
      });
      updated += res.count;
    }
    if (needReady.length > 0) {
      const res = await this.prisma.order.updateMany({
        where: { id: { in: needReady.map((o) => o.id) } },
        data: { sketchReadyAt: now },
      });
      updated += res.count;
    }

    if (updated > 0) {
      this.logger.debug(
        `Sketch-backfill: проставлено меток ${updated} (старт ${needStart.length}, готов ${needReady.length})`,
      );
    }
    return updated;
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
    const statusObservedAt = new Date();
    let synced = 0;

    const existingInfos = await this.prisma.bluesalesOrderInfo.findMany({
      where: { bsOrderId: { in: bsOrders.map((o) => o.id) } },
      select: { bsOrderId: true, orderId: true },
    });
    const existingByBsId = new Map(existingInfos.map((info) => [info.bsOrderId, info]));

    await this.syncReferenceDictionaries(bsOrders.map((o) => o.customer ?? null));

    for (const bsOrder of bsOrders) {
      try {
        const leadId = await this.upsertLead(bsOrder.customer ?? null, false);
        await this.upsertOrder(
          bsOrder,
          leadId,
          existingByBsId.get(bsOrder.id) ?? null,
          statusObservedAt,
        );
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
    // Справочники имён обновляем один раз на весь батч (а не на каждого лида).
    await this.syncReferenceDictionaries(customers);
    for (const customer of customers) {
      try {
        const leadId = await this.upsertLead(customer, false);
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

  /**
   * @param syncReferences обновлять ли справочники имён (source/salesChannel/tags)
   *   сразу для этого лида. В батч-обработке передаём `false`, а справочники
   *   обновляем один раз на весь батч через {@link syncReferenceDictionaries},
   *   чтобы не делать одинаковые upsert'ы по кругу на каждой записи.
   */
  async upsertLead(customer: BsCustomer | null, syncReferences = true): Promise<number | null> {
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
    const tagReferences = this.extractCustomerTagReferences(customer);

    // При одиночном upsert сначала создаём записи справочника: relation connect
    // ниже должен ссылаться только на уже существующие теги.
    if (syncReferences) {
      await this.upsertTags(tagReferences);
      await this.upsertSourceName(sourcePair);
      await this.upsertSalesChannelName(salesChannelPair);
    }
    const tagConnections = tagReferences.map(({ bsTagId }) => ({ bsTagId }));

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
        tagIds: tagConnections.map(({ bsTagId }) => bsTagId),
        tags: { connect: tagConnections },
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
        tagIds: tagConnections.map(({ bsTagId }) => bsTagId),
        tags: { set: tagConnections },
        crmStatus,
        lastSyncedAt: new Date(),
      },
    });

    return lead.id;
  }

  /**
   * Батч-обновление справочников имён BlueSales (источники, каналы продаж, теги)
   * для набора клиентов. Пары {id -> name} дедуплицируются по всему батчу, поэтому
   * вместо N×(1 источник + 1 канал + M тегов) upsert'ов на каждого лида делаем лишь
   * по одному upsert на каждый уникальный id. Это резко снижает число обращений к БД.
   */
  private async syncReferenceDictionaries(
    customers: Array<BsCustomer | null | undefined>,
  ): Promise<void> {
    const sources = new Map<string, string>();
    const salesChannels = new Map<string, string>();
    const tags = new Map<string, TagReference>();

    for (const customer of customers) {
      if (!customer) continue;
      const sourcePair = this.extractCustomerSourcePair(customer);
      if (sourcePair) sources.set(sourcePair.bsSourceId, sourcePair.name);
      const salesChannelPair = this.extractCustomerSalesChannelPair(customer);
      if (salesChannelPair) salesChannels.set(salesChannelPair.bsSalesChannelId, salesChannelPair.name);
      for (const tag of this.extractCustomerTagReferences(customer)) {
        const previous = tags.get(tag.bsTagId);
        tags.set(tag.bsTagId, {
          bsTagId: tag.bsTagId,
          name: tag.name ?? previous?.name ?? null,
          color: tag.color ?? previous?.color ?? null,
        });
      }
    }

    for (const [bsSourceId, name] of sources) {
      await this.upsertSourceName({ bsSourceId, name });
    }
    for (const [bsSalesChannelId, name] of salesChannels) {
      await this.upsertSalesChannelName({ bsSalesChannelId, name });
    }
    await this.upsertTags([...tags.values()]);
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

  /** Актуализирует накопительный справочник тегов BlueSales. */
  private async upsertTags(tags: TagReference[]): Promise<void> {
    for (const { bsTagId, name, color } of tags) {
      await this.prisma.bluesalesTag.upsert({
        where: { bsTagId },
        create: {
          bsTagId,
          name: name ?? `Тег #${bsTagId}`,
          color,
        },
        update: {
          ...(name ? { name } : {}),
          ...(color ? { color } : {}),
        },
      });
    }
  }

  /**
   * @param existing предвыбранная запись BluesalesOrderInfo (orderId по bsOrderId).
   *   Если передана (в т.ч. `null` = «точно нет»), пропускаем findUnique по bsOrderId.
   *   Если `undefined` — запись подгружается здесь (для одиночных вызовов).
   */
  async upsertOrder(
    bsOrder: BsOrder,
    leadId: number | null,
    existing?: { orderId: number } | null,
    statusObservedAt: Date = new Date(),
  ): Promise<void> {
    const orderNumber = this.resolveOrderNumber(bsOrder);
    const title = `Заказ номер ${orderNumber}`;
    const bsCreatedAt = this.parseDate(bsOrder.date);
    const crm = bsOrder.customer?.crmStatus ?? null;

    // Менеджер ведения — менеджер клиента в BlueSales.
    const deliveryManagerName = this.resolveDeliveryManagerName(bsOrder);
    // Менеджер оформления — кастомное поле заказа «Оформление».
    const onboardingManagerName = this.resolveOnboardingManagerName(bsOrder);

    const statusData = {
      orderStatusId: bsOrder.orderStatus?.id ?? null,
      orderStatus: bsOrder.orderStatus?.name ?? null,
      orderStatusObservedAt: statusObservedAt,
    };
    const infoData = {
      bsCustomerId: bsOrder.customer?.id ?? null,
      bsNumber: orderNumber,
      crmStatusId: crm?.id ?? null,
      crmStatus: crm?.name ?? null,
      totalSum: bsOrder.totalSumMinusDiscount ?? null,
      prepaymentSum: this.extractPrepaymentSum(bsOrder),
      bsCreatedAt,
      rawPayload: bsOrder as unknown as Prisma.InputJsonValue,
      lastSyncedAt: new Date(),
    };

    const managerData = { deliveryManagerName, onboardingManagerName };

    // В батч-режиме existing уже предвыбран (см. refreshBatch), иначе грузим здесь.
    const existingInfo =
      existing !== undefined
        ? existing
        : await this.prisma.bluesalesOrderInfo.findUnique({
            where: { bsOrderId: bsOrder.id },
            select: { orderId: true },
          });

    const statusName = bsOrder.orderStatus?.name ?? null;

    if (existingInfo) {
      const sketchData = await this.resolveSketchTimestampUpdate(
        existingInfo.orderId,
        statusName,
      );
      await this.prisma.$transaction(async (tx) => {
        await tx.$queryRaw`
          SELECT "orderId"
          FROM "BluesalesOrderInfo"
          WHERE "orderId" = ${existingInfo.orderId}
          FOR UPDATE
        `;
        const [currentInfo, pendingChanges] = await Promise.all([
          tx.bluesalesOrderInfo.findUnique({
            where: { bsOrderId: bsOrder.id },
            select: { orderStatusObservedAt: true },
          }),
          tx.orderStatusChange.count({
            where: {
              orderId: existingInfo.orderId,
              state: {
                in: [
                  OrderStatusChangeState.PENDING,
                  OrderStatusChangeState.PROCESSING,
                  OrderStatusChangeState.RETRY,
                ],
              },
            },
          }),
        ]);
        const canApplyStatus =
          pendingChanges === 0 &&
          (!currentInfo?.orderStatusObservedAt ||
            currentInfo.orderStatusObservedAt.getTime() < statusObservedAt.getTime());

        await tx.bluesalesOrderInfo.update({
          where: { bsOrderId: bsOrder.id },
          data: { ...infoData, ...(canApplyStatus ? statusData : {}) },
        });
        await tx.order.update({
          where: { id: existingInfo.orderId },
          data: {
            ...managerData,
            ...(canApplyStatus ? sketchData : {}),
            ...(leadId ? { leadId } : {}),
          },
        });
      });
      return;
    }

    const sameNumber = await this.prisma.order.findUnique({ where: { orderNumber } });
    if (sameNumber) {
      const sketchData = await this.resolveSketchTimestampUpdate(sameNumber.id, statusName);
      await this.prisma.bluesalesOrderInfo.create({
        data: { ...infoData, ...statusData, bsOrderId: bsOrder.id, orderId: sameNumber.id },
      });
      await this.prisma.order.update({
        where: { id: sameNumber.id },
        data: {
          ...managerData,
          ...sketchData,
          ...(leadId && sameNumber.leadId !== leadId ? { leadId } : {}),
        },
      });
      return;
    }

    // Новый заказ: если он сразу приходит в статусе эскиза — проставляем метку.
    const newSketchData = computeSketchTimestampUpdate(statusName, {
      sketchStartedAt: null,
      sketchReadyAt: null,
    });
    await this.prisma.order.create({
      data: {
        orderNumber,
        title,
        source: OrderSource.BLUESALES,
        leadId: leadId ?? undefined,
        ...managerData,
        ...newSketchData,
        bluesalesInfo: { create: { ...infoData, ...statusData, bsOrderId: bsOrder.id } },
      },
    });
  }

  /**
   * Вычисляет апдейт меток эскиза для существующего заказа при синке из BlueSales.
   * Дешёвый short-circuit: лишний запрос в БД делаем только когда статус относится
   * к циклу эскиза («Готовим эскиз» / «Эскиз готов»).
   */
  private async resolveSketchTimestampUpdate(
    orderId: number,
    statusName: string | null,
  ): Promise<Partial<SketchTimestamps>> {
    if (!isSketchTrackedStatus(statusName)) {
      return {};
    }
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      select: { sketchStartedAt: true, sketchReadyAt: true },
    });
    if (!order) {
      return {};
    }
    return computeSketchTimestampUpdate(statusName, order);
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

  /** Полные данные тегов клиента для справочника и связи Lead.tags. */
  private extractCustomerTagReferences(customer: BsCustomer): TagReference[] {
    const tags = customer.tags;
    if (!Array.isArray(tags)) return [];
    const references = new Map<string, TagReference>();
    for (const tag of tags) {
      if (!tag || typeof tag !== 'object' || tag.id == null) continue;
      const bsTagId = String(tag.id);
      const name = (tag.name ?? '').trim() || null;
      const color = this.pickString(
        tag.color,
        tag.colour,
        tag.hexColor,
        tag.backgroundColor,
        tag.backColor,
        tag['background'],
      );
      references.set(bsTagId, { bsTagId, name, color });
    }
    return [...references.values()];
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

type TagReference = {
  bsTagId: string;
  name: string | null;
  color: string | null;
};
