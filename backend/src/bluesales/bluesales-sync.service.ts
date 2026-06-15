import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { OrderSource, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { BluesalesApiService, BsCustomer, BsOrder } from './bluesales-api.service';

const SYNC_KEY_ORDERS = 'bluesales:orders';

@Injectable()
export class BluesalesSyncService implements OnModuleInit {
  private readonly logger = new Logger(BluesalesSyncService.name);
  private readonly enabled: boolean;
  private readonly syncDays: number;
  private readonly vkGroupId: string;

  // Защита от наложения прогонов (cron раз в минуту)
  private isRunning = false;

  constructor(
    private readonly api: BluesalesApiService,
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {
    this.enabled = this.config.get<string>('BLUESALES_ENABLED', 'true') !== 'false';
    this.syncDays = Number(this.config.get<string>('BLUESALES_SYNC_DAYS', '7')) || 7;
    this.vkGroupId = this.config.get<string>('BLUESALES_VK_GROUP_ID', '');
  }

  onModuleInit(): void {
    if (!this.enabled) {
      this.logger.warn('BlueSales sync отключён (BLUESALES_ENABLED=false)');
    } else if (!this.api.isConfigured) {
      this.logger.warn(
        'BlueSales sync включён, но не заданы BLUESALES_LOGIN / BLUESALES_PASSWORD',
      );
    } else {
      this.logger.log(`BlueSales sync активен (период: последние ${this.syncDays} дн.)`);
    }
  }

  @Cron(CronExpression.EVERY_MINUTE)
  async handleCron(): Promise<void> {
    if (!this.enabled || !this.api.isConfigured) {
      return;
    }
    if (this.isRunning) {
      this.logger.debug('Предыдущий прогон ещё выполняется — пропуск');
      return;
    }
    this.isRunning = true;
    try {
      await this.syncOrders();
    } catch (err) {
      this.logger.error(`Ошибка синхронизации BlueSales: ${(err as Error).message}`);
    } finally {
      this.isRunning = false;
    }
  }

  /**
   * Тянет заказы за последние N дней и upsert-ит их в нашу систему вместе с
   * лидами (клиентами). Лиды и заказы обновляются в рамках одного прогона —
   * единая очередь запросов к BlueSales не позволяет слать их одновременно.
   */
  async syncOrders(): Promise<{ orders: number; leads: number }> {
    const now = new Date();
    const dateFrom = new Date(now.getTime() - this.syncDays * 24 * 60 * 60 * 1000);

    await this.markRun(SYNC_KEY_ORDERS);

    let orders: BsOrder[];
    try {
      orders = await this.api.getOrders(dateFrom, now);
    } catch (err) {
      await this.markError(SYNC_KEY_ORDERS, (err as Error).message);
      throw err;
    }

    const leadIds = new Set<number>();
    let ordersSynced = 0;

    for (const bsOrder of orders) {
      try {
        const leadId = await this.upsertLead(bsOrder.customer ?? null);
        if (leadId) {
          leadIds.add(leadId);
        }
        await this.upsertOrder(bsOrder, leadId);
        ordersSynced += 1;
      } catch (err) {
        this.logger.error(
          `Не удалось обработать заказ BS#${bsOrder.id}: ${(err as Error).message}`,
        );
      }
    }

    await this.markSuccess(SYNC_KEY_ORDERS, ordersSynced);
    this.logger.log(
      `BlueSales sync: заказов ${ordersSynced}/${orders.length}, лидов ${leadIds.size}`,
    );
    return { orders: ordersSynced, leads: leadIds.size };
  }

  private async upsertLead(customer: BsCustomer | null): Promise<number | null> {
    if (!customer?.id) {
      return null;
    }
    const fullName = (customer.fullName ?? '').trim() || null;
    const name = fullName ? fullName.split(/\s+/)[0] : null;
    const vkUserId = customer.vk?.id ? String(customer.vk.id) : null;
    const vkDialogUrl = this.buildVkDialogUrl(customer);
    const crmStatus = customer.crmStatus?.name ?? null;

    const lead = await this.prisma.lead.upsert({
      where: { bsCustomerId: customer.id },
      create: {
        bsCustomerId: customer.id,
        name,
        fullName,
        vkUserId,
        vkDialogUrl,
        crmStatus,
        lastSyncedAt: new Date(),
      },
      update: {
        name,
        fullName,
        vkUserId,
        vkDialogUrl,
        crmStatus,
        lastSyncedAt: new Date(),
      },
    });
    return lead.id;
  }

  private async upsertOrder(bsOrder: BsOrder, leadId: number | null): Promise<void> {
    const orderNumber = this.resolveOrderNumber(bsOrder);
    const title = `Заказ номер ${orderNumber}`;
    const bsCreatedAt = this.parseDate(bsOrder.date);
    // У заказа BS нет собственного crmStatus — это статус клиента в воронке
    const crm = bsOrder.customer?.crmStatus ?? null;

    const infoData = {
      bsNumber: orderNumber,
      orderStatusId: bsOrder.orderStatus?.id ?? null,
      orderStatus: bsOrder.orderStatus?.name ?? null,
      crmStatusId: crm?.id ?? null,
      crmStatus: crm?.name ?? null,
      totalSum: bsOrder.totalSumMinusDiscount ?? null,
      bsCreatedAt,
      rawPayload: bsOrder as unknown as Prisma.InputJsonValue,
      lastSyncedAt: new Date(),
    };

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
          data: leadId ? { leadId } : {},
        }),
      ]);
      return;
    }

    // Заказа с таким bsOrderId ещё нет — создаём (или переиспользуем
    // существующий заказ с тем же номером, напр. созданный вручную).
    const sameNumber = await this.prisma.order.findUnique({
      where: { orderNumber },
    });

    if (sameNumber) {
      await this.prisma.bluesalesOrderInfo.create({
        data: { ...infoData, bsOrderId: bsOrder.id, orderId: sameNumber.id },
      });
      if (leadId && sameNumber.leadId !== leadId) {
        await this.prisma.order.update({
          where: { id: sameNumber.id },
          data: { leadId },
        });
      }
      return;
    }

    await this.prisma.order.create({
      data: {
        orderNumber,
        title,
        source: OrderSource.BLUESALES,
        leadId: leadId ?? undefined,
        bluesalesInfo: {
          create: { ...infoData, bsOrderId: bsOrder.id },
        },
      },
    });
  }

  private resolveOrderNumber(bsOrder: BsOrder): string {
    const candidate =
      this.firstNonEmpty(bsOrder.internalNumber, bsOrder.externalNumber) ??
      bsOrder.id;
    return String(candidate);
  }

  private firstNonEmpty(
    ...values: Array<number | string | null | undefined>
  ): number | string | null {
    for (const v of values) {
      if (v !== null && v !== undefined && String(v).trim() !== '') {
        return v;
      }
    }
    return null;
  }

  /**
   * Ссылка на диалог сообщество↔лид в ВК. Для VK-клиентов используем
   * customer.vk.messagesGroupId; если его нет — фолбэк на BLUESALES_VK_GROUP_ID.
   */
  private buildVkDialogUrl(customer: BsCustomer): string | null {
    const userId = customer.vk?.id ? String(customer.vk.id) : null;
    if (!userId) {
      return null;
    }
    const groupId = customer.vk?.messagesGroupId
      ? String(customer.vk.messagesGroupId)
      : this.vkGroupId || null;
    if (!groupId) {
      return null;
    }
    return `https://vk.com/gim${groupId}?sel=${userId}`;
  }

  /** BlueSales отдаёт даты как "DD.MM.YYYY" (опц. " HH:mm:ss"). */
  private parseDate(value?: string | null): Date | null {
    if (!value) {
      return null;
    }
    const match = value.match(
      /^(\d{2})\.(\d{2})\.(\d{4})(?:\s+(\d{2}):(\d{2})(?::(\d{2}))?)?$/,
    );
    if (match) {
      const [, dd, mm, yyyy, hh = '0', min = '0', ss = '0'] = match;
      const parsed = new Date(
        Date.UTC(
          Number(yyyy),
          Number(mm) - 1,
          Number(dd),
          Number(hh),
          Number(min),
          Number(ss),
        ),
      );
      return Number.isNaN(parsed.getTime()) ? null : parsed;
    }
    const fallback = new Date(value);
    return Number.isNaN(fallback.getTime()) ? null : fallback;
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
