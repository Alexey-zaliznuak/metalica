import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OrderStatusChange, OrderStatusChangeState } from '@prisma/client';
import { randomUUID } from 'crypto';
import { BluesalesApiService } from '../bluesales/bluesales-api.service';
import { PrismaService } from '../prisma/prisma.service';

const ACTIVE_STATES: OrderStatusChangeState[] = [
  OrderStatusChangeState.PENDING,
  OrderStatusChangeState.PROCESSING,
  OrderStatusChangeState.RETRY,
];

type ClaimedStatusChange = OrderStatusChange & { leaseToken: string };

@Injectable()
export class OrderStatusOutboxProcessor implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OrderStatusOutboxProcessor.name);
  private readonly pollIntervalMs: number;
  private readonly maxRetryDelayMs: number;
  private readonly leaseMs: number;
  private active = false;
  private startupRecovered = false;
  private nextLeaseSweepAt = 0;

  constructor(
    private readonly prisma: PrismaService,
    private readonly api: BluesalesApiService,
    config: ConfigService,
  ) {
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
        const change = await this.claimNext();
        if (change) {
          await this.deliver(change);
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

  private async claimNext(): Promise<ClaimedStatusChange | null> {
    const now = new Date();
    const leaseToken = randomUUID();
    return this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<Array<{ id: number }>>`
        SELECT candidate."id"
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
        ORDER BY candidate."id" ASC
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      `;
      const id = rows[0]?.id;
      if (id == null) return null;

      const change = await tx.orderStatusChange.update({
        where: { id },
        data: {
          state: OrderStatusChangeState.PROCESSING,
          lockedAt: now,
          leaseToken,
        },
      });
      return { ...change, leaseToken };
    });
  }

  private async deliver(change: ClaimedStatusChange): Promise<void> {
    let heartbeat: ReturnType<typeof setInterval> | null = null;
    let leaseLost = false;
    try {
      const heartbeatMs = Math.min(Math.max(Math.floor(this.leaseMs / 3), 1000), 30_000);
      heartbeat = setInterval(() => {
        void this.renewLease(change)
          .then((renewed) => {
            if (!renewed) leaseLost = true;
          })
          .catch((error) => {
            this.logger.warn(
              `Не удалось продлить lease изменения #${change.id}: ${(error as Error).message}`,
            );
          });
      }, heartbeatMs);

      const info = await this.prisma.bluesalesOrderInfo.findUnique({
        where: { orderId: change.orderId },
        select: { bsOrderId: true },
      });
      if (!info) {
        throw new Error('У заказа отсутствуют данные BlueSales');
      }
      if (leaseLost || !(await this.renewLease(change))) return;

      this.logger.log(
        `Доставка статуса: queueId=${change.id}; orderId=${change.orderId}; ` +
          `bsOrderId=${info.bsOrderId}; ${change.fromStatusId ?? 'null'} -> ` +
          `${change.toStatusId}; attempt=${change.attempts + 1}`,
      );
      await this.api.setOrderStatus(info.bsOrderId, change.toStatusId);
      if (leaseLost || !(await this.renewLease(change))) return;
      const verificationOrders = await this.api.getOrdersByIds(
        [info.bsOrderId],
        'interactive',
      );
      if (leaseLost || !(await this.renewLease(change))) return;
      const observedAt = new Date();
      const actual = verificationOrders.find((order) => order.id === info.bsOrderId);
      const actualStatusId = actual?.orderStatus?.id ?? null;
      if (!actual) {
        throw new Error(
          `Проверка статуса не прошла: BlueSales не вернул заказ; ` +
            `queueId=${change.id}; orderId=${change.orderId}; bsOrderId=${info.bsOrderId}; ` +
            `expected=${change.toStatusId}; returnedCount=${verificationOrders.length}; ` +
            `returnedIds=${JSON.stringify(verificationOrders.map((order) => order.id))}`,
        );
      }
      if (actualStatusId !== change.toStatusId) {
        throw new Error(
          `Проверка статуса не прошла: статус отличается; ` +
            `queueId=${change.id}; orderId=${change.orderId}; ` +
            `bsOrderId=${info.bsOrderId}; expected=${change.toStatusId}; ` +
            `actual=${actualStatusId ?? 'null'} (${actual?.orderStatus?.name ?? 'без имени'})`,
        );
      }

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
            `bsOrderId=${info.bsOrderId}; statusId=${actualStatusId}`,
        );
      }
    } catch (error) {
      await this.scheduleRetry(change, error);
    } finally {
      if (heartbeat) clearInterval(heartbeat);
    }
  }

  private async renewLease(change: ClaimedStatusChange): Promise<boolean> {
    const renewed = await this.prisma.orderStatusChange.updateMany({
      where: {
        id: change.id,
        state: OrderStatusChangeState.PROCESSING,
        leaseToken: change.leaseToken,
      },
      data: { lockedAt: new Date() },
    });
    return renewed.count === 1;
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

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
