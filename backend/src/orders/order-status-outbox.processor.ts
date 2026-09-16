import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OrderStatusChange, OrderStatusChangeState } from '@prisma/client';
import { randomUUID } from 'crypto';
import { BsOrder, BluesalesApiService } from '../bluesales/bluesales-api.service';
import { PrismaService } from '../prisma/prisma.service';

const ACTIVE_STATES: OrderStatusChangeState[] = [
  OrderStatusChangeState.PENDING,
  OrderStatusChangeState.PROCESSING,
  OrderStatusChangeState.RETRY,
];

type ClaimedStatusChange = OrderStatusChange & { leaseToken: string; verifyFirst: boolean };

class BluesalesOrderNotFoundError extends Error {}

@Injectable()
export class OrderStatusOutboxProcessor implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OrderStatusOutboxProcessor.name);
  private readonly pollIntervalMs: number;
  private readonly maxRetryDelayMs: number;
  private readonly leaseMs: number;
  private readonly batchWindowMs: number;
  private readonly batchSize: number;
  private active = false;
  private startupRecovered = false;
  private nextLeaseSweepAt = 0;

  constructor(
    private readonly prisma: PrismaService,
    private readonly api: BluesalesApiService,
    config: ConfigService,
  ) {
    this.batchWindowMs = this.envInt(config, 'ORDER_STATUS_OUTBOX_BATCH_WINDOW_MS', 10_000);
    this.batchSize = Math.max(1, Math.min(500, Math.floor(this.envInt(config, 'ORDER_STATUS_OUTBOX_BATCH_SIZE', 500))));
    this.pollIntervalMs = this.envInt(config, 'ORDER_STATUS_OUTBOX_POLL_MS', 500);
    this.maxRetryDelayMs = this.envInt(
      config,
      'ORDER_STATUS_OUTBOX_MAX_RETRY_DELAY_MS',
      300_000,
    );
    this.leaseMs = this.envInt(config, 'ORDER_STATUS_OUTBOX_LEASE_MS', 3_600_000);
  }

  onModuleInit(): void {
    this.active = true;
    void this.run();
  }

  onModuleDestroy(): void {
    this.active = false;
  }

  private envInt(config: ConfigService, key: string, fallback: number): number {
    const value = Number(config.get<string>(key));
    return Number.isFinite(value) && value > 0 ? value : fallback;
  }

  private async run(): Promise<void> {
    this.logger.log('Durable-очередь статусов заказов запущена');

    while (this.active) {
      try {
        if (!this.startupRecovered) {
          await this.recoverQueueOnStartup();
          this.startupRecovered = true;
        }
        if (Date.now() >= this.nextLeaseSweepAt) {
          await this.releaseStaleLeases();
          this.nextLeaseSweepAt = Date.now() + Math.min(this.leaseMs / 2, 60_000);
        }
        const batch = await this.claimBatch();
        if (batch.length > 0) {
          await this.deliverBatch(batch);
          continue;
        }
      } catch (error) {
        this.logger.error(`Ошибка processor очереди статусов: ${(error as Error).message}`);
      }
      await this.sleep(this.pollIntervalMs);
    }
  }

  /**
   * В текущем deployment backend имеет одну реплику. После рестарта прежнего
   * владельца lease уже нет, поэтому PROCESSING можно вернуть сразу, не ожидая час.
   * Заодно снимаем накопившийся backoff: после выкладки исправления очередь должна
   * проверить старые задачи немедленно.
   */
  private async recoverQueueOnStartup(): Promise<void> {
    const now = new Date();
    const [processing, delayedRetries] = await this.prisma.$transaction([
      this.prisma.orderStatusChange.updateMany({
        where: { state: OrderStatusChangeState.PROCESSING },
        data: {
          state: OrderStatusChangeState.RETRY,
          lockedAt: null,
          leaseToken: null,
          nextAttemptAt: now,
          lastError: 'Предыдущая обработка прервана перезапуском backend',
        },
      }),
      this.prisma.orderStatusChange.updateMany({
        where: {
          state: OrderStatusChangeState.RETRY,
          nextAttemptAt: { gt: now },
        },
        data: { nextAttemptAt: now },
      }),
    ]);
    const active = await this.prisma.orderStatusChange.groupBy({
      by: ['state'],
      where: { state: { in: ACTIVE_STATES } },
      _count: { _all: true },
    });
    this.logger.log(
      `Очередь восстановлена: processing=${processing.count}; ` +
        `retryAwakened=${delayedRetries.count}; active=${JSON.stringify(active)}`,
    );
  }

  private async releaseStaleLeases(): Promise<void> {
    const staleBefore = new Date(Date.now() - this.leaseMs);
    const result = await this.prisma.orderStatusChange.updateMany({
      where: {
        state: OrderStatusChangeState.PROCESSING,
        OR: [{ lockedAt: null }, { lockedAt: { lt: staleBefore } }],
      },
      data: {
        state: OrderStatusChangeState.RETRY,
        lockedAt: null,
        leaseToken: null,
        nextAttemptAt: new Date(),
        lastError: 'Истёк lease предыдущей попытки обработки',
      },
    });
    if (result.count > 0) {
      this.logger.warn(`Возвращено в очередь зависших изменений: ${result.count}`);
    }
  }

  /** Окно отсчитывается от срока самой ранней доступной задачи и переживает рестарт. */
  private async claimBatch(): Promise<ClaimedStatusChange[]> {
    const now = new Date();
    const cutoff = new Date(now.getTime() - this.batchWindowMs);
    const leaseToken = randomUUID();
    return this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<Array<{
        id: number; state: OrderStatusChangeState; nextAttemptAt: Date;
      }>>`
        SELECT candidate."id", candidate."state", candidate."nextAttemptAt"
        FROM "OrderStatusChange" AS candidate
        WHERE candidate."state" IN ('PENDING', 'RETRY')
          AND candidate."nextAttemptAt" <= ${now}
          AND NOT EXISTS (
            SELECT 1
            FROM "OrderStatusChange" AS earlier
            WHERE earlier."orderId" = candidate."orderId"
              AND earlier."id" < candidate."id"
              AND earlier."state" IN ('PENDING', 'PROCESSING', 'RETRY')
          )
        ORDER BY candidate."nextAttemptAt" ASC, candidate."id" ASC
        LIMIT ${this.batchSize}
        FOR UPDATE SKIP LOCKED
      `;
      if (!rows.length || rows[0].nextAttemptAt > cutoff) return [];

      const ids = rows.map((row) => row.id);
      const retries = new Set(rows.filter((row) => row.state === 'RETRY').map((row) => row.id));
      await tx.orderStatusChange.updateMany({
        where: { id: { in: ids } },
        data: { state: OrderStatusChangeState.PROCESSING, lockedAt: now, leaseToken },
      });
      const changes = await tx.orderStatusChange.findMany({
        where: { id: { in: ids } }, orderBy: { id: 'asc' },
      });
      // RETRY включает прерванные при рестарте попытки: запись могла уже пройти.
      return changes.map((change) => ({ ...change, leaseToken, verifyFirst: retries.has(change.id) }));
    });
  }

  private async deliverBatch(changes: ClaimedStatusChange[]): Promise<void> {
    const pending = new Map(changes.map((change) => [change.id, change]));
    const heartbeatMs = Math.min(Math.max(Math.floor(this.leaseMs / 3), 1000), 30_000);
    const heartbeat = setInterval(() => {
      void this.renewBatchLeases([...pending.values()]).catch((error) => {
        this.logger.warn(`Не удалось продлить lease пачки: ${(error as Error).message}`);
      });
    }, heartbeatMs);
    const retainOwned = async () => {
      const owned = new Set((await this.renewBatchLeases([...pending.values()])).map((c) => c.id));
      for (const id of pending.keys()) if (!owned.has(id)) pending.delete(id);
    };
    const fail = async (change: ClaimedStatusChange, error: unknown) => {
      if (error instanceof BluesalesOrderNotFoundError && change.attempts >= 1) {
        await this.failPermanently(change, error);
      } else {
        await this.scheduleRetry(change, error);
      }
      pending.delete(change.id);
    };
    const complete = async (change: ClaimedStatusChange, actual: BsOrder, observedAt: Date) => {
      try {
        await this.completeChange(change, actual, observedAt);
        pending.delete(change.id);
      } catch (error) {
        await fail(change, error);
      }
    };
    try {
      const infos = await this.prisma.bluesalesOrderInfo.findMany({
        where: { orderId: { in: changes.map((c) => c.orderId) } },
        select: { orderId: true, bsOrderId: true },
      });
      const bsIds = new Map(infos.map((info) => [info.orderId, info.bsOrderId]));
      for (const change of pending.values()) {
        if (!bsIds.has(change.orderId)) await fail(change, new Error('У заказа отсутствуют данные BlueSales'));
      }
      await retainOwned();
      const read = (batch: ClaimedStatusChange[]) => this.api.withLabel(
        'order-status-batch-verify',
        () => this.api.getOrdersByIds(batch.map((c) => bsIds.get(c.orderId)!), 'interactive'),
      );
      const missing = (change: ClaimedStatusChange) => new BluesalesOrderNotFoundError(
        `BlueSales не вернул заказ; queueId=${change.id}; bsOrderId=${bsIds.get(change.orderId)}`,
      );

      // Сначала выясняем исход предыдущей попытки, даже если она оборвалась до
      // сохранения результата в БД. Уже применённый статус повторно не отправляем.
      const retries = [...pending.values()].filter((c) => c.verifyFirst);
      if (retries.length) {
        try {
          const observedAt = new Date();
          const actuals = new Map((await read(retries)).map((order) => [order.id, order]));
          await retainOwned();
          for (const change of retries) {
            if (!pending.has(change.id)) continue;
            const actual = actuals.get(bsIds.get(change.orderId)!);
            if (!actual) await fail(change, missing(change));
            else if (actual.orderStatus?.id === change.toStatusId) await complete(change, actual, observedAt);
          }
        } catch (error) {
          for (const change of retries) if (pending.has(change.id)) await fail(change, error);
        }
      }

      const groups = new Map<number, ClaimedStatusChange[]>();
      for (const change of pending.values()) {
        const group = groups.get(change.toStatusId) ?? [];
        group.push(change);
        groups.set(change.toStatusId, group);
      }
      for (const [statusId, group] of groups) {
        await retainOwned();
        const owned = group.filter((change) => pending.has(change.id));
        if (!owned.length) continue;
        try {
          await this.api.withLabel('order-status-batch-write', () => this.api.setOrdersStatus(
            owned.map((c) => bsIds.get(c.orderId)!), statusId,
          ));
        } catch (error) {
          // В том числе неопределённый результат записи: следующая попытка начнётся с GET.
          for (const change of owned) await fail(change, error);
        }
      }
      await retainOwned();
      const toVerify = [...pending.values()];
      if (!toVerify.length) return;
      const observedAt = new Date();
      const actuals = new Map((await read(toVerify)).map((order) => [order.id, order]));
      await retainOwned();
      for (const change of toVerify) {
        if (!pending.has(change.id)) continue;
        const actual = actuals.get(bsIds.get(change.orderId)!);
        if (!actual) await fail(change, missing(change));
        else if (actual.orderStatus?.id !== change.toStatusId) {
          await fail(change, new Error(`Статус отличается; expected=${change.toStatusId}; actual=${actual.orderStatus?.id}`));
        } else await complete(change, actual, observedAt);
      }
    } catch (error) {
      for (const change of pending.values()) await fail(change, error);
    } finally {
      clearInterval(heartbeat);
    }
  }

  private async completeChange(change: ClaimedStatusChange, actual: BsOrder, observedAt: Date): Promise<void> {
    const actualStatusId = actual.orderStatus!.id;
    const saved = await this.prisma.$transaction(async (tx) => {
      const completed = await tx.orderStatusChange.updateMany({
        where: {
          id: change.id,
          state: OrderStatusChangeState.PROCESSING,
          leaseToken: change.leaseToken,
        },
        data: {
          state: OrderStatusChangeState.SUCCEEDED,
          attempts: { increment: 1 },
          lockedAt: null,
          leaseToken: null,
          lastError: null,
          completedAt: new Date(),
        },
      });
      if (completed.count === 0) return false;

      const newerPending = await tx.orderStatusChange.count({
        where: {
          orderId: change.orderId,
          id: { gt: change.id },
          state: { in: ACTIVE_STATES },
        },
      });
      if (newerPending === 0) {
        await tx.bluesalesOrderInfo.updateMany({
          where: {
            orderId: change.orderId,
            OR: [
              { orderStatusObservedAt: null },
              { orderStatusObservedAt: { lt: observedAt } },
            ],
          },
          data: {
            orderStatusId: actualStatusId,
            orderStatus: actual.orderStatus?.name ?? change.toStatusName,
            orderStatusObservedAt: observedAt,
            lastSyncedAt: observedAt,
          },
        });
      }
      return true;
    });
    if (saved) {
      this.logger.log(
        `Статус доставлен: queueId=${change.id}; orderId=${change.orderId}; ` +
          `bsOrderId=${actual.id}; statusId=${actualStatusId}`,
      );
    }
  }

  private async renewBatchLeases(changes: ClaimedStatusChange[]): Promise<ClaimedStatusChange[]> {
    if (!changes.length) return [];
    const where = {
      id: { in: changes.map((change) => change.id) },
      state: OrderStatusChangeState.PROCESSING,
      leaseToken: changes[0].leaseToken,
    };
    const renewed = await this.prisma.orderStatusChange.updateMany({ where, data: { lockedAt: new Date() } });
    if (renewed.count === changes.length) return changes;
    const owned = new Set((await this.prisma.orderStatusChange.findMany({ where, select: { id: true } })).map((c) => c.id));
    return changes.filter((change) => owned.has(change.id));
  }

  private async scheduleRetry(change: ClaimedStatusChange, error: unknown): Promise<void> {
    const attempts = change.attempts + 1;
    const delayMs = Math.min(1000 * 2 ** Math.min(attempts - 1, 12), this.maxRetryDelayMs);
    const message = (error as Error).message || String(error);
    await this.prisma.orderStatusChange.updateMany({
      where: {
        id: change.id,
        state: OrderStatusChangeState.PROCESSING,
        leaseToken: change.leaseToken,
      },
      data: {
        state: OrderStatusChangeState.RETRY,
        attempts,
        nextAttemptAt: new Date(Date.now() + delayMs),
        lockedAt: null,
        leaseToken: null,
        lastError: message.slice(0, 2000),
      },
    });
    this.logger.warn(
      `Статус не доставлен: queueId=${change.id}; orderId=${change.orderId}; ` +
        `targetStatusId=${change.toStatusId}; retry=${attempts}; ` +
        `delayMs=${delayMs}; error=${message}`,
    );
  }

  private async failPermanently(
    change: ClaimedStatusChange,
    error: BluesalesOrderNotFoundError,
  ): Promise<void> {
    const attempts = change.attempts + 1;
    const message = error.message || String(error);
    const failed = await this.prisma.orderStatusChange.updateMany({
      where: {
        id: change.id,
        state: OrderStatusChangeState.PROCESSING,
        leaseToken: change.leaseToken,
      },
      data: {
        state: OrderStatusChangeState.FAILED,
        attempts,
        lockedAt: null,
        leaseToken: null,
        lastError: message.slice(0, 2000),
        completedAt: new Date(),
      },
    });
    if (failed.count > 0) {
      this.logger.error(
        `Доставка статуса прекращена: заказ удалён или недоступен в BlueSales; ` +
          `queueId=${change.id}; orderId=${change.orderId}; attempts=${attempts}; ` +
          `error=${message}`,
      );
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
