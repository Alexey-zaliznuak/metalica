import { Controller, Get, Param, Query } from '@nestjs/common';
import { OrderStatusChangeState } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  BluesalesApiService,
  BsOrder,
  BsRequestPriority,
} from './bluesales-api.service';

const ACTIVE_STATES: OrderStatusChangeState[] = [
  OrderStatusChangeState.PENDING,
  OrderStatusChangeState.PROCESSING,
  OrderStatusChangeState.RETRY,
];

/**
 * ВРЕМЕННЫЙ read-only контроллер диагностики синка BlueSales.
 * Ничего не мутирует: только читает нашу БД и опрашивает BlueSales на чтение.
 * Удалить вместе с BluesalesController после разбора расхождений статусов.
 */
@Controller('diag')
export class BluesalesDiagController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly api: BluesalesApiService,
  ) {}

  private parsePriority(value?: string): BsRequestPriority {
    return value === 'background' ? 'background' : 'interactive';
  }

  private parseIds(raw?: string): number[] {
    return (raw ?? '')
      .split(',')
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isFinite(n) && n > 0);
  }

  private statusOf(order: BsOrder | undefined) {
    if (!order) return null;
    return {
      id: order.orderStatus?.id ?? null,
      name: order.orderStatus?.name ?? null,
      date: order.date ?? null,
      internalNumber: order.internalNumber ?? null,
      customerId: order.customer?.id ?? null,
      customerCrmStatus: order.customer?.crmStatus?.name ?? null,
    };
  }

  /**
   * GET /api/diag/health
   * Честные метрики свежести синка. Ключевой момент: lastSyncedAt двигается даже
   * когда BlueSales не вернул заказ, а orderStatusObservedAt — только когда статус
   * реально применён. Расхождение этих двух метрик и есть «лаг в минутах, а статус
   * стоит часами».
   */
  @Get('health')
  async health() {
    const [freshness] = await this.prisma.$queryRaw<
      Array<Record<string, unknown>>
    >`
      SELECT
        count(*)                                                             AS in_window_total,
        min("lastSyncedAt")                                                  AS synced_oldest,
        max("lastSyncedAt")                                                  AS synced_newest,
        min("orderStatusObservedAt")                                         AS observed_oldest,
        max("orderStatusObservedAt")                                         AS observed_newest,
        count(*) FILTER (WHERE "orderStatusObservedAt" IS NULL)               AS observed_null,
        count(*) FILTER (WHERE "lastSyncedAt" < now() - interval '30 min')    AS synced_older_30m,
        count(*) FILTER (WHERE "lastSyncedAt" < now() - interval '2 hour')    AS synced_older_2h,
        count(*) FILTER (WHERE "orderStatusObservedAt" < now() - interval '30 min') AS observed_older_30m,
        count(*) FILTER (WHERE "orderStatusObservedAt" < now() - interval '2 hour')  AS observed_older_2h,
        count(*) FILTER (WHERE "orderStatusObservedAt" < now() - interval '24 hour') AS observed_older_24h,
        count(*) FILTER (WHERE "lastSyncedAt" - "orderStatusObservedAt" > interval '1 hour')  AS frozen_1h,
        count(*) FILTER (WHERE "lastSyncedAt" - "orderStatusObservedAt" > interval '24 hour') AS frozen_24h
      FROM "BluesalesOrderInfo"
      WHERE "bsCreatedAt" >= now() - interval '60 days'
    `;

    const [outOfWindow] = await this.prisma.$queryRaw<
      Array<Record<string, unknown>>
    >`
      SELECT count(*) AS total,
             count(*) FILTER (WHERE "bsCreatedAt" IS NULL) AS bs_created_null,
             min("lastSyncedAt") AS synced_oldest,
             max("lastSyncedAt") AS synced_newest
      FROM "BluesalesOrderInfo"
      WHERE "bsCreatedAt" IS NULL OR "bsCreatedAt" < now() - interval '60 days'
    `;

    const queueByState = await this.prisma.orderStatusChange.groupBy({
      by: ['state'],
      _count: { _all: true },
    });

    return {
      serverNow: new Date().toISOString(),
      note:
        'in_window = заказы, попадающие в refresh-loop (bsCreatedAt >= now()-60d). ' +
        'frozen_* = заказы, у которых lastSyncedAt свежий, а orderStatusObservedAt отстал: ' +
        'признак того, что BlueSales не вернул заказ, но очередь всё равно посчитала его обработанным.',
      refreshLoop: this.serialize(freshness),
      outOfRefreshWindow: this.serialize(outOfWindow),
      bsApiQueue: { ...this.api.getQueueStats(), ...this.api.getPauseState() },
      statusChangeQueue: queueByState.map((row) => ({
        state: row.state,
        count: row._count._all,
      })),
    };
  }

  /**
   * GET /api/diag/frozen?hours=1&limit=100
   * Заказы, чей статус «заморожен»: lastSyncedAt обновляется, а статус нет.
   */
  @Get('frozen')
  async frozen(@Query('hours') hoursRaw?: string, @Query('limit') limitRaw?: string) {
    const hours = Math.min(Math.max(Number(hoursRaw) || 1, 0), 24 * 30);
    const limit = Math.min(Math.max(Number(limitRaw) || 100, 1), 500);

    const rows = await this.prisma.$queryRaw<Array<Record<string, unknown>>>`
      SELECT i."orderId", o."orderNumber", i."bsOrderId", i."orderStatus",
             i."orderStatusId", i."crmStatus",
             i."orderStatusObservedAt", i."lastSyncedAt", i."bsCreatedAt",
             EXTRACT(EPOCH FROM (i."lastSyncedAt" - i."orderStatusObservedAt")) AS frozen_seconds
      FROM "BluesalesOrderInfo" i
      JOIN "Order" o ON o.id = i."orderId"
      WHERE i."bsCreatedAt" >= now() - interval '60 days'
        AND i."orderStatusObservedAt" IS NOT NULL
        AND i."lastSyncedAt" - i."orderStatusObservedAt" > make_interval(hours => ${hours}::int)
      ORDER BY (i."lastSyncedAt" - i."orderStatusObservedAt") DESC
      LIMIT ${limit}
    `;

    return {
      serverNow: new Date().toISOString(),
      thresholdHours: hours,
      count: rows.length,
      note:
        'frozen_seconds = насколько orderStatusObservedAt отстал от lastSyncedAt. ' +
        'Это заказы, которые refresh-loop считает обновлёнными, но статус им не применялся.',
      orders: rows.map((r) => this.serialize(r)),
    };
  }

  /**
   * GET /api/diag/order/29542727
   * Полная картина по заказу из нашей БД (номер заказа или внутренний id).
   */
  @Get('order/:key')
  async order(@Param('key') key: string) {
    const order = await this.findOrder(key);
    if (!order) return { error: `Заказ "${key}" не найден`, key };

    const [statusChanges, events] = await Promise.all([
      this.prisma.orderStatusChange.findMany({
        where: { orderId: order.id },
        orderBy: { id: 'desc' },
        take: 30,
      }),
      this.prisma.orderEvent.findMany({
        where: { orderId: order.id },
        orderBy: { id: 'desc' },
        take: 30,
      }),
    ]);

    const info = order.bluesalesInfo;
    const raw = (info?.rawPayload ?? null) as { orderStatus?: unknown } | null;

    return {
      serverNow: new Date().toISOString(),
      order: {
        id: order.id,
        orderNumber: order.orderNumber,
        source: order.source,
        note: order.note,
        sketchStartedAt: order.sketchStartedAt,
        sketchReadyAt: order.sketchReadyAt,
        createdAt: order.createdAt,
        updatedAt: order.updatedAt,
      },
      bluesalesInfo: info
        ? {
            bsOrderId: info.bsOrderId,
            bsNumber: info.bsNumber,
            bsCustomerId: info.bsCustomerId,
            orderStatusId: info.orderStatusId,
            orderStatus: info.orderStatus,
            orderStatusObservedAt: info.orderStatusObservedAt,
            crmStatusId: info.crmStatusId,
            crmStatus: info.crmStatus,
            bsCreatedAt: info.bsCreatedAt,
            lastSyncedAt: info.lastSyncedAt,
            updatedAt: info.updatedAt,
            rawPayloadOrderStatus: raw?.orderStatus ?? null,
            secondsSinceLastSync: info.lastSyncedAt
              ? Math.round((Date.now() - info.lastSyncedAt.getTime()) / 1000)
              : null,
            secondsSinceStatusObserved: info.orderStatusObservedAt
              ? Math.round((Date.now() - info.orderStatusObservedAt.getTime()) / 1000)
              : null,
          }
        : null,
      activeStatusChanges: statusChanges.filter((c) => ACTIVE_STATES.includes(c.state))
        .length,
      statusChanges,
      events,
    };
  }

  /**
   * GET /api/diag/order/29542727/live
   * Сравнивает статус в нашей БД со статусом, который BlueSales отдаёт прямо сейчас.
   * Запрос идёт через общую очередь API (priority=interactive по умолчанию),
   * поэтому не конкурирует с фоновым синком за единственную сессию BlueSales.
   */
  @Get('order/:key/live')
  async orderLive(@Param('key') key: string, @Query('priority') priorityRaw?: string) {
    const order = await this.findOrder(key);
    if (!order) return { error: `Заказ "${key}" не найден`, key };
    const info = order.bluesalesInfo;
    if (!info) return { error: `У заказа "${key}" нет данных BlueSales`, key };

    const priority = this.parsePriority(priorityRaw);
    const startedAt = Date.now();
    const byId = await this.api.getOrdersByIds([info.bsOrderId], priority);
    const byIdMs = Date.now() - startedAt;

    // Отдельно спрашиваем по внутреннему номеру: так видно дубли заказов в BS
    // с одинаковым номером, но разными id (наш Order привязан к одному из них).
    const numeric = Number(info.bsNumber ?? order.orderNumber);
    let byNumber: BsOrder[] = [];
    let byNumberMs: number | null = null;
    if (Number.isFinite(numeric)) {
      const t = Date.now();
      byNumber = await this.api.getOrdersByInternalNumbers([numeric], priority);
      byNumberMs = Date.now() - t;
    }

    const live = byId.find((o) => o.id === info.bsOrderId);
    const dbStatusId = info.orderStatusId;
    const liveStatusId = live?.orderStatus?.id ?? null;

    return {
      serverNow: new Date().toISOString(),
      priority,
      orderId: order.id,
      orderNumber: order.orderNumber,
      bsOrderId: info.bsOrderId,
      db: {
        orderStatusId: dbStatusId,
        orderStatus: info.orderStatus,
        orderStatusObservedAt: info.orderStatusObservedAt,
        crmStatus: info.crmStatus,
        lastSyncedAt: info.lastSyncedAt,
      },
      liveByIds: {
        elapsedMs: byIdMs,
        returnedCount: byId.length,
        returnedIds: byId.map((o) => o.id),
        status: this.statusOf(live),
      },
      liveByInternalNumber: {
        elapsedMs: byNumberMs,
        requested: Number.isFinite(numeric) ? numeric : null,
        returnedCount: byNumber.length,
        returnedIds: byNumber.map((o) => o.id),
        statuses: byNumber.map((o) => this.statusOf(o)),
        duplicateBsOrders: byNumber.length > 1,
      },
      verdict: !live
        ? 'BLUESALES_NE_VERNUL_ZAKAZ — BS не отдаёт этот заказ по ids, поэтому статус в нашей БД заморожен'
        : liveStatusId === dbStatusId
          ? 'SOVPADAET — наша БД совпадает с BlueSales; расхождение надо искать в UI BlueSales (order status vs crm status клиента)'
          : 'RASHOZHDENIE — BlueSales отдаёт другой статус, чем лежит у нас',
      rawLiveOrder: live ?? null,
    };
  }

  /**
   * GET /api/diag/probe?ids=1,2,3&priority=interactive
   * Проверяет, какие из запрошенных id BlueSales реально возвращает.
   * Молча пропущенные id — причина «замороженных» статусов.
   */
  @Get('probe')
  async probe(@Query('ids') idsRaw?: string, @Query('priority') priorityRaw?: string) {
    const ids = this.parseIds(idsRaw);
    if (ids.length === 0) {
      return { error: 'Передайте ids=12533581,12520279 (BS order id, через запятую)' };
    }
    const priority = this.parsePriority(priorityRaw);
    const startedAt = Date.now();
    const orders = await this.api.getOrdersByIds(ids, priority);
    const elapsedMs = Date.now() - startedAt;

    const returned = new Set(orders.map((o) => o.id));
    return {
      serverNow: new Date().toISOString(),
      priority,
      elapsedMs,
      requestedCount: ids.length,
      requestedIds: ids,
      returnedCount: orders.length,
      returnedIds: [...returned],
      missingIds: ids.filter((id) => !returned.has(id)),
      statuses: orders.map((o) => this.statusOf(o)),
    };
  }

  /**
   * GET /api/diag/probe-frozen?hours=1&priority=interactive
   * Берёт «замороженные» заказы из БД и спрашивает их у BlueSales одним батчем —
   * сразу видно, действительно ли BS их не отдаёт.
   */
  @Get('probe-frozen')
  async probeFrozen(
    @Query('hours') hoursRaw?: string,
    @Query('priority') priorityRaw?: string,
    @Query('limit') limitRaw?: string,
  ) {
    const hours = Math.min(Math.max(Number(hoursRaw) || 1, 0), 24 * 30);
    const limit = Math.min(Math.max(Number(limitRaw) || 50, 1), 200);

    const rows = await this.prisma.$queryRaw<
      Array<{ orderId: number; bsOrderId: number; orderStatus: string | null }>
    >`
      SELECT i."orderId", i."bsOrderId", i."orderStatus"
      FROM "BluesalesOrderInfo" i
      WHERE i."bsCreatedAt" >= now() - interval '60 days'
        AND i."orderStatusObservedAt" IS NOT NULL
        AND i."lastSyncedAt" - i."orderStatusObservedAt" > make_interval(hours => ${hours}::int)
      ORDER BY (i."lastSyncedAt" - i."orderStatusObservedAt") DESC
      LIMIT ${limit}
    `;
    if (rows.length === 0) {
      return { serverNow: new Date().toISOString(), thresholdHours: hours, frozen: 0 };
    }

    const priority = this.parsePriority(priorityRaw);
    const ids = rows.map((r) => r.bsOrderId);
    const startedAt = Date.now();
    const orders = await this.api.getOrdersByIds(ids, priority);
    const elapsedMs = Date.now() - startedAt;
    const byId = new Map(orders.map((o) => [o.id, o]));

    return {
      serverNow: new Date().toISOString(),
      priority,
      thresholdHours: hours,
      elapsedMs,
      requestedCount: ids.length,
      returnedCount: orders.length,
      missingIds: ids.filter((id) => !byId.has(id)),
      comparison: rows.map((r) => {
        const live = byId.get(r.bsOrderId);
        return {
          orderId: r.orderId,
          bsOrderId: r.bsOrderId,
          dbStatus: r.orderStatus,
          liveStatus: live?.orderStatus?.name ?? null,
          returnedByBs: Boolean(live),
          differs: Boolean(live) && live?.orderStatus?.name !== r.orderStatus,
        };
      }),
    };
  }

  /**
   * GET /api/diag/queue
   * Состояние durable-очереди исходящих смен статуса + очереди запросов к BS.
   */
  @Get('queue')
  async queue() {
    const [byState, active, failed] = await Promise.all([
      this.prisma.orderStatusChange.groupBy({
        by: ['state'],
        _count: { _all: true },
      }),
      this.prisma.orderStatusChange.findMany({
        where: { state: { in: ACTIVE_STATES } },
        orderBy: { id: 'asc' },
        take: 100,
        include: { order: { select: { orderNumber: true } } },
      }),
      this.prisma.orderStatusChange.findMany({
        where: { state: OrderStatusChangeState.FAILED },
        orderBy: { id: 'desc' },
        take: 50,
        include: { order: { select: { orderNumber: true } } },
      }),
    ]);

    return {
      serverNow: new Date().toISOString(),
      note:
        'Пока по заказу висит PENDING/PROCESSING/RETRY, синк из BlueSales НЕ применяет ' +
        'его статус (canApplyStatus=false в bluesales-sync.service). Застрявшая запись ' +
        'здесь заморозит статус заказа навсегда.',
      byState: byState.map((r) => ({ state: r.state, count: r._count._all })),
      blockedOrderIds: [...new Set(active.map((c) => c.orderId))],
      active,
      failed,
      bsApiQueue: { ...this.api.getQueueStats(), ...this.api.getPauseState() },
    };
  }

  /**
   * GET /api/diag/duplicates
   * Заказы BlueSales с одинаковым внутренним номером — из-за них наш Order может
   * быть привязан к «неправильному» bsOrderId и получать чужой статус.
   */
  @Get('duplicates')
  async duplicates() {
    const rows = await this.prisma.$queryRaw<Array<Record<string, unknown>>>`
      SELECT "bsNumber", count(*) AS cnt,
             array_agg("bsOrderId" ORDER BY "bsOrderId") AS bs_order_ids,
             array_agg("orderId" ORDER BY "bsOrderId") AS order_ids,
             array_agg("orderStatus" ORDER BY "bsOrderId") AS statuses
      FROM "BluesalesOrderInfo"
      WHERE "bsNumber" IS NOT NULL
      GROUP BY "bsNumber"
      HAVING count(*) > 1
      ORDER BY cnt DESC
      LIMIT 100
    `;
    return {
      serverNow: new Date().toISOString(),
      count: rows.length,
      duplicates: rows.map((r) => this.serialize(r)),
    };
  }

  private async findOrder(key: string) {
    const asId = Number(key);
    const order = await this.prisma.order.findFirst({
      where: {
        OR: [
          { orderNumber: key },
          ...(Number.isInteger(asId) && asId > 0 ? [{ id: asId }] : []),
        ],
      },
      include: { bluesalesInfo: true },
    });
    return order;
  }

  /** BigInt из count(*) не сериализуется в JSON — приводим к number/строке. */
  private serialize(row: Record<string, unknown> | undefined) {
    if (!row) return null;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(row)) {
      out[k] = typeof v === 'bigint' ? Number(v) : v;
    }
    return out;
  }
}
