import { Injectable, Logger } from '@nestjs/common';
import { OrderDirection, Prisma, Role } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { resolveOrderDirection } from './order-direction';

/**
 * Окно автораспределения: заказы, входящие в статус вне этого интервала
 * (ночью), художникам не назначаются и ждут ручного назначения.
 */
export const AUTO_ASSIGN_TZ = process.env.AUTO_ASSIGN_TZ ?? 'Europe/Moscow';
const START_HOUR = Number(process.env.AUTO_ASSIGN_START_HOUR ?? 10);
const END_HOUR = Number(process.env.AUTO_ASSIGN_END_HOUR ?? 21);

/** Время жизни кэша настроек автоназначения у статусов, мс. */
const SETTINGS_CACHE_TTL = 5_000;

interface AssignSettings {
  sketch: boolean;
  revision: boolean;
}

const DESIGNER_FIELDS = {
  [Role.SKETCH_DESIGNER]: {
    column: 'sketchDesignerId',
    event: 'sketchDesigner',
    label: 'Художник эскиза',
  },
  [Role.REVISION_DESIGNER]: {
    column: 'revisionDesignerId',
    event: 'revisionDesigner',
    label: 'Художник правок',
  },
} as const;

type DesignerRole = keyof typeof DESIGNER_FIELDS;

/** Час в часовом поясе автораспределения (0–23). */
export function hourInZone(now: Date, timeZone = AUTO_ASSIGN_TZ): number {
  const formatted = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    hourCycle: 'h23',
  }).format(now);
  return Number(formatted);
}

@Injectable()
export class AssignmentService {
  private readonly logger = new Logger(AssignmentService.name);
  private settingsCache: {
    map: Map<number, AssignSettings>;
    expiresAt: number;
  } | null = null;
  private settingsLoad: Promise<Map<number, AssignSettings>> | null = null;

  constructor(private readonly prisma: PrismaService) {}

  isWindowOpen(now: Date = new Date()): boolean {
    const hour = hourInZone(now);
    return hour >= START_HOUR && hour < END_HOUR;
  }

  /**
   * Подбирает художников заказу, вошедшему в статус `statusId`.
   *
   * Ничего не делает, если статус не требует автоназначения, окно закрыто,
   * направление заказа не определяется однозначно или в нужном круге нет
   * художников на смене. Уже назначенных художников не перезаписывает.
   */
  async maybeAssign(orderId: number, statusId: number | null): Promise<void> {
    if (statusId === null) return;

    const settings = await this.getAssignSettings(statusId);
    if (!settings.sketch && !settings.revision) return;

    if (!this.isWindowOpen()) {
      this.logger.debug(
        `Заказ #${orderId}: автораспределение вне окна ${START_HOUR}:00–${END_HOUR}:00 (${AUTO_ASSIGN_TZ})`,
      );
      return;
    }

    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      select: {
        sketchDesignerId: true,
        revisionDesignerId: true,
        lead: {
          select: { tags: { select: { name: true } } },
        },
      },
    });
    if (!order) return;

    const roles: DesignerRole[] = [];
    if (settings.sketch && order.sketchDesignerId === null) {
      roles.push(Role.SKETCH_DESIGNER);
    }
    if (settings.revision && order.revisionDesignerId === null) {
      roles.push(Role.REVISION_DESIGNER);
    }
    if (roles.length === 0) return;

    const direction = resolveOrderDirection(
      order.lead?.tags.map((tag) => tag.name) ?? [],
    );
    if (direction === null) {
      this.logger.debug(
        `Заказ #${orderId}: направление не определено однозначно, назначение вручную`,
      );
      return;
    }

    for (const role of roles) {
      try {
        await this.assignNext(orderId, direction, role);
      } catch (err) {
        this.logger.error(
          `Заказ #${orderId}: не удалось назначить ${DESIGNER_FIELDS[role].label}: ${
            (err as Error).message
          }`,
        );
      }
    }
  }

  /**
   * Round-robin по кругу «направление × роль». Курсор круга блокируется на время
   * транзакции, поэтому параллельные синк и ручная смена статуса не выдают
   * одного художника дважды подряд.
   */
  private async assignNext(
    orderId: number,
    direction: OrderDirection,
    role: DesignerRole,
  ): Promise<void> {
    const field = DESIGNER_FIELDS[role];

    const assigned = await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`
        INSERT INTO "AssignmentCursor" ("direction", "designerRole", "createdAt", "updatedAt")
        VALUES (${direction}::"OrderDirection", ${role}::"Role", now(), now())
        ON CONFLICT ("direction", "designerRole") DO NOTHING
      `;
      const locked = await tx.$queryRaw<Array<{ lastUserId: number | null }>>`
        SELECT "lastUserId"
        FROM "AssignmentCursor"
        WHERE "direction" = ${direction}::"OrderDirection"
          AND "designerRole" = ${role}::"Role"
        FOR UPDATE
      `;

      const candidates = await tx.user.findMany({
        where: { role, onShift: true, directions: { has: direction } },
        select: { id: true, name: true },
        orderBy: { id: 'asc' },
      });
      if (candidates.length === 0) return null;

      const lastUserId = locked[0]?.lastUserId ?? null;
      const next =
        candidates.find(
          (candidate) => lastUserId === null || candidate.id > lastUserId,
        ) ?? candidates[0];

      // Пока ждали блокировку, художника могли назначить вручную — тогда
      // круг не двигаем.
      const updated = await tx.order.updateMany({
        where: { id: orderId, [field.column]: null },
        data: { [field.column]: next.id, updatedAt: new Date() },
      });
      if (updated.count === 0) return null;

      await tx.$executeRaw`
        UPDATE "AssignmentCursor"
        SET "lastUserId" = ${next.id}, "updatedAt" = now()
        WHERE "direction" = ${direction}::"OrderDirection"
          AND "designerRole" = ${role}::"Role"
      `;
      await tx.orderEvent.create({
        data: {
          orderId,
          actorId: null,
          field: field.event,
          oldValue: null,
          newValue: next.name,
          meta: {
            newId: next.id,
            source: 'auto-assign',
            direction,
          } satisfies Prisma.InputJsonObject,
        },
      });
      return next;
    });

    if (assigned) {
      this.logger.log(
        `Заказ #${orderId}: ${field.label} — ${assigned.name} (круг ${direction})`,
      );
    }
  }

  /** Настройки автоназначения статуса с коротким кэшем: статус читается на каждый заказ синка. */
  private async getAssignSettings(statusId: number): Promise<AssignSettings> {
    const cached = this.settingsCache;
    if (cached && cached.expiresAt > Date.now()) {
      return cached.map.get(statusId) ?? { sketch: false, revision: false };
    }

    if (!this.settingsLoad) {
      this.settingsLoad = this.prisma.bluesalesOrderStatus
        .findMany({
          where: {
            OR: [{ assignSketchDesigner: true }, { assignRevisionDesigner: true }],
          },
          select: {
            bsOrderStatusId: true,
            assignSketchDesigner: true,
            assignRevisionDesigner: true,
          },
        })
        .then((statuses) => {
          const map = new Map<number, AssignSettings>(
            statuses.map((status) => [
              status.bsOrderStatusId,
              {
                sketch: status.assignSketchDesigner,
                revision: status.assignRevisionDesigner,
              },
            ]),
          );
          this.settingsCache = { map, expiresAt: Date.now() + SETTINGS_CACHE_TTL };
          return map;
        })
        .finally(() => {
          this.settingsLoad = null;
        });
    }

    const map = await this.settingsLoad;
    return map.get(statusId) ?? { sketch: false, revision: false };
  }

  /**
   * Журнал выдачи заказов художникам: автораспределение и ручные назначения.
   * События снятия художника (newValue пустой) не показываем — заказ тогда
   * никому не отдан.
   */
  async journal(options: {
    limit?: number;
    before?: number;
    role?: 'sketch' | 'revision';
    source?: 'auto' | 'manual';
    q?: string;
  } = {}) {
    const limit = Math.min(Math.max(options.limit ?? 50, 1), 100);
    const field =
      options.role === 'sketch'
        ? 'sketchDesigner'
        : options.role === 'revision'
          ? 'revisionDesigner'
          : { in: ['sketchDesigner', 'revisionDesigner'] };

    const query = options.q?.trim();
    const where: Prisma.OrderEventWhereInput = {
      field,
      newValue: { not: null },
      ...(options.before ? { id: { lt: options.before } } : {}),
      ...(options.source === 'auto'
        ? { actorId: null }
        : options.source === 'manual'
          ? { actorId: { not: null } }
          : {}),
      ...(query
        ? {
            OR: [
              { order: { orderNumber: { contains: query, mode: 'insensitive' } } },
              { newValue: { contains: query, mode: 'insensitive' } },
            ],
          }
        : {}),
    };

    const rows = await this.prisma.orderEvent.findMany({
      where,
      orderBy: { id: 'desc' },
      take: limit + 1,
      include: {
        actor: { select: { id: true, name: true, role: true } },
        order: { select: { id: true, orderNumber: true, title: true } },
      },
    });

    const hasMore = rows.length > limit;
    const slice = hasMore ? rows.slice(0, limit) : rows;
    return {
      items: slice.map((row) => this.serializeJournalEntry(row)),
      nextCursor: hasMore ? slice[slice.length - 1].id : null,
      hasMore,
    };
  }

  private serializeJournalEntry(row: {
    id: number;
    createdAt: Date;
    field: string;
    oldValue: string | null;
    newValue: string | null;
    actor: { id: number; name: string; role: Role } | null;
    order: { id: number; orderNumber: string; title: string | null };
    meta: Prisma.JsonValue;
  }) {
    const meta = this.readMetaObject(row.meta);
    const source = meta.source === 'auto-assign' || row.actor === null ? 'auto' : 'manual';
    const direction =
      typeof meta.direction === 'string' && meta.direction.length > 0
        ? meta.direction
        : null;
    const assigneeId = typeof meta.newId === 'number' ? meta.newId : null;

    return {
      id: row.id,
      createdAt: row.createdAt,
      field: row.field,
      source,
      direction,
      assignee: {
        id: assigneeId,
        name: row.newValue,
      },
      previousAssignee: row.oldValue,
      actor: row.actor,
      order: row.order,
    };
  }

  private readMetaObject(meta: Prisma.JsonValue): Record<string, Prisma.JsonValue> {
    if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return {};
    return meta as Record<string, Prisma.JsonValue>;
  }
}
