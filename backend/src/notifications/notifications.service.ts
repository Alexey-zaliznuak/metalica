import {
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ChatType, NotificationType, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ChatsGateway } from '../realtime/chats.gateway';

const RETENTION_MS = 3 * 24 * 60 * 60 * 1000;

/** Временно отключает создание и push новых уведомлений. Вернуть: поставить false. */
const NOTIFICATIONS_CREATION_DISABLED = true;

export type ChatMessageNotificationPayload = {
  chatId: number;
  chatName: string;
};

export type OrderStatusNotificationPayload = {
  orderId: number;
  orderNumber: string;
  statusId: number;
  statusName: string;
};

type NotificationRow = {
  id: number;
  userId: number;
  type: NotificationType;
  dedupeKey: string | null;
  payload: Prisma.JsonValue;
  readAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(
    private prisma: PrismaService,
    private gateway: ChatsGateway,
  ) {}

  async list(userId: number, options: { cursor?: number; limit?: number } = {}) {
    const limit = Math.min(Math.max(options.limit ?? 20, 1), 50);
    const since = new Date(Date.now() - RETENTION_MS);

    const rows = await this.prisma.notification.findMany({
      where: {
        userId,
        createdAt: { gte: since },
        ...(options.cursor ? { id: { lt: options.cursor } } : {}),
      },
      orderBy: [{ id: 'desc' }],
      take: limit + 1,
    });

    const hasMore = rows.length > limit;
    const slice = hasMore ? rows.slice(0, limit) : rows;
    const nextCursor = hasMore ? slice[slice.length - 1].id : null;

    return {
      items: slice.map((row) => this.serialize(row)),
      nextCursor,
      hasMore,
    };
  }

  async unreadCount(userId: number) {
    const since = new Date(Date.now() - RETENTION_MS);
    const count = await this.prisma.notification.count({
      where: {
        userId,
        readAt: null,
        createdAt: { gte: since },
      },
    });
    return { count };
  }

  async markAllRead(userId: number) {
    const now = new Date();
    await this.prisma.notification.updateMany({
      where: { userId, readAt: null },
      data: { readAt: now, dedupeKey: null },
    });
    this.gateway.emitToUser(userId, 'notification:count', { count: 0 });
    return { ok: true, count: 0 };
  }

  async markOneRead(userId: number, notificationId: number) {
    const existing = await this.prisma.notification.findFirst({
      where: { id: notificationId, userId },
      select: { id: true, readAt: true },
    });
    if (!existing) {
      throw new NotFoundException('Уведомление не найдено');
    }
    if (!existing.readAt) {
      await this.prisma.notification.update({
        where: { id: notificationId },
        data: { readAt: new Date(), dedupeKey: null },
      });
    }
    const { count } = await this.unreadCount(userId);
    this.gateway.emitToUser(userId, 'notification:count', { count });
    return { ok: true, count };
  }

  async markChatRead(userId: number, chatId: number) {
    await this.ensureCanAccessChat(chatId, userId);
    const dedupeKey = this.chatDedupeKey(chatId);
    await this.prisma.notification.updateMany({
      where: { userId, readAt: null, dedupeKey },
      data: { readAt: new Date(), dedupeKey: null },
    });
    const { count } = await this.unreadCount(userId);
    this.gateway.emitToUser(userId, 'notification:count', { count });
    return { ok: true, count };
  }

  async getSettings(userId: number) {
    const rows = await this.prisma.userOrderStatusNotification.findMany({
      where: { userId },
      select: { statusId: true },
      orderBy: { statusId: 'asc' },
    });
    return { orderStatusIds: rows.map((row) => row.statusId) };
  }

  async updateSettings(userId: number, orderStatusIds: number[]) {
    const uniqueIds = Array.from(new Set(orderStatusIds));
    if (uniqueIds.length > 0) {
      const known = await this.prisma.bluesalesOrderStatus.findMany({
        where: { bsOrderStatusId: { in: uniqueIds } },
        select: { bsOrderStatusId: true },
      });
      const knownSet = new Set(known.map((row) => row.bsOrderStatusId));
      const unknown = uniqueIds.filter((id) => !knownSet.has(id));
      if (unknown.length > 0) {
        throw new NotFoundException(`Неизвестные статусы: ${unknown.join(', ')}`);
      }
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.userOrderStatusNotification.deleteMany({ where: { userId } });
      if (uniqueIds.length > 0) {
        await tx.userOrderStatusNotification.createMany({
          data: uniqueIds.map((statusId) => ({ userId, statusId })),
        });
      }
    });

    return this.getSettings(userId);
  }

  async setChatNotificationsEnabled(userId: number, chatId: number, enabled: boolean) {
    await this.ensureCanAccessChat(chatId, userId);
    await this.prisma.chatNotificationPref.upsert({
      where: { userId_chatId: { userId, chatId } },
      create: { userId, chatId, enabled },
      update: { enabled },
    });
    return { chatId, enabled };
  }

  async getChatNotificationsEnabledMap(userId: number, chatIds: number[]) {
    if (chatIds.length === 0) {
      return new Map<number, boolean>();
    }
    const prefs = await this.prisma.chatNotificationPref.findMany({
      where: { userId, chatId: { in: chatIds } },
      select: { chatId: true, enabled: true },
    });
    return new Map(prefs.map((pref) => [pref.chatId, pref.enabled]));
  }

  /**
   * Создаёт (или пропускает по dedupe) chat-уведомления после нового сообщения.
   */
  async notifyChatMessage(params: {
    chatId: number;
    chatName: string;
    chatType: ChatType;
    authorId: number;
  }) {
    if (NOTIFICATIONS_CREATION_DISABLED) {
      return;
    }
    const dedupeKey = this.chatDedupeKey(params.chatId);
    const payload = {
      chatId: params.chatId,
      chatName: params.chatName,
    } satisfies ChatMessageNotificationPayload;
    const payloadJson = JSON.stringify(payload);

    let inserted: NotificationRow[];
    if (params.chatType === ChatType.PUBLIC) {
      inserted = await this.prisma.$queryRaw<NotificationRow[]>`
        INSERT INTO "Notification" ("userId", "type", "dedupeKey", "payload", "createdAt", "updatedAt")
        SELECT u.id, 'CHAT_MESSAGE'::"NotificationType", ${dedupeKey}, ${payloadJson}::jsonb, NOW(), NOW()
        FROM "User" u
        WHERE u.id <> ${params.authorId}
          AND NOT EXISTS (
            SELECT 1
            FROM "ChatNotificationPref" p
            WHERE p."chatId" = ${params.chatId}
              AND p."userId" = u.id
              AND p.enabled = false
          )
        ON CONFLICT ("userId", "dedupeKey") DO NOTHING
        RETURNING id, "userId", type, "dedupeKey", payload, "readAt", "createdAt", "updatedAt"
      `;
    } else {
      inserted = await this.prisma.$queryRaw<NotificationRow[]>`
        INSERT INTO "Notification" ("userId", "type", "dedupeKey", "payload", "createdAt", "updatedAt")
        SELECT m."userId", 'CHAT_MESSAGE'::"NotificationType", ${dedupeKey}, ${payloadJson}::jsonb, NOW(), NOW()
        FROM "ChatMember" m
        WHERE m."chatId" = ${params.chatId}
          AND m."userId" <> ${params.authorId}
          AND NOT EXISTS (
            SELECT 1
            FROM "ChatNotificationPref" p
            WHERE p."chatId" = ${params.chatId}
              AND p."userId" = m."userId"
              AND p.enabled = false
          )
        ON CONFLICT ("userId", "dedupeKey") DO NOTHING
        RETURNING id, "userId", type, "dedupeKey", payload, "readAt", "createdAt", "updatedAt"
      `;
    }

    if (inserted.length === 0) {
      return;
    }

    await this.emitCreated(inserted);
  }

  /**
   * Уведомления о входе заказа в статус. excludeUserId — автор ручной смены.
   */
  async notifyOrderStatus(params: {
    orderId: number;
    orderNumber: string;
    statusId: number;
    statusName: string;
    excludeUserId?: number | null;
  }) {
    if (NOTIFICATIONS_CREATION_DISABLED) {
      return;
    }
    const recipients = await this.prisma.userOrderStatusNotification.findMany({
      where: {
        statusId: params.statusId,
        ...(params.excludeUserId
          ? { userId: { not: params.excludeUserId } }
          : {}),
      },
      select: { userId: true },
    });
    if (recipients.length === 0) {
      return;
    }

    const payload = {
      orderId: params.orderId,
      orderNumber: params.orderNumber,
      statusId: params.statusId,
      statusName: params.statusName,
    } satisfies OrderStatusNotificationPayload;
    const payloadJson = JSON.stringify(payload);
    const userIds = recipients.map((row) => row.userId);

    const inserted = await this.prisma.$queryRawUnsafe<NotificationRow[]>(
      `
      INSERT INTO "Notification" ("userId", "type", "dedupeKey", "payload", "createdAt", "updatedAt")
      SELECT u.id, 'ORDER_STATUS'::"NotificationType", NULL, $1::jsonb, NOW(), NOW()
      FROM unnest($2::int[]) AS u(id)
      RETURNING id, "userId", type, "dedupeKey", payload, "readAt", "createdAt", "updatedAt"
      `,
      payloadJson,
      userIds,
    );

    if (inserted.length === 0) {
      return;
    }

    await this.emitCreated(inserted);
  }

  @Cron(CronExpression.EVERY_HOUR)
  async purgeExpired() {
    const cutoff = new Date(Date.now() - RETENTION_MS);
    const result = await this.prisma.notification.deleteMany({
      where: { createdAt: { lt: cutoff } },
    });
    if (result.count > 0) {
      this.logger.log(`Удалено устаревших уведомлений: ${result.count}`);
    }
  }

  private async emitCreated(rows: NotificationRow[]) {
    const userIds = Array.from(new Set(rows.map((row) => row.userId)));
    const since = new Date(Date.now() - RETENTION_MS);
    const counts = await this.prisma.notification.groupBy({
      by: ['userId'],
      where: {
        userId: { in: userIds },
        readAt: null,
        createdAt: { gte: since },
      },
      _count: { _all: true },
    });
    const countByUser = new Map(counts.map((row) => [row.userId, row._count._all]));

    for (const row of rows) {
      this.gateway.emitToUser(row.userId, 'notification:created', {
        notification: this.serialize(row),
        unreadCount: countByUser.get(row.userId) ?? 0,
      });
    }
  }

  private serialize(row: {
    id: number;
    type: NotificationType;
    payload: Prisma.JsonValue;
    readAt: Date | null;
    createdAt: Date;
    updatedAt: Date;
  }) {
    return {
      id: row.id,
      type: row.type,
      payload: row.payload,
      readAt: row.readAt,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  private chatDedupeKey(chatId: number) {
    return `chat:${chatId}`;
  }

  private async ensureCanAccessChat(chatId: number, userId: number) {
    const chat = await this.prisma.chat.findUnique({
      where: { id: chatId },
      select: {
        type: true,
        members: { where: { userId }, select: { id: true } },
      },
    });
    if (!chat) {
      throw new NotFoundException('Чат не найден');
    }
    if (chat.type !== ChatType.PUBLIC && chat.members.length === 0) {
      throw new ForbiddenException('Нет доступа к этому чату');
    }
  }
}
