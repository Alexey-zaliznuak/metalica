import { Injectable } from '@nestjs/common';
import { Prisma, Role } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

// Часовой пояс по умолчанию для расчёта рабочего окна — Москва (UTC+3).
const DEFAULT_TZ_OFFSET_MINUTES = 180;
const DEFAULT_WORK_START_HOUR = 9;
const DEFAULT_WORK_END_HOUR = 21;

/**
 * Считает «рабочее» время (в секундах) между openedAt и closedAt, вычитая
 * нерабочие часы каждых суток. Рабочий день — суточное окно [workStartHour, workEndHour)
 * в часовом поясе, заданном tzOffsetMinutes.
 *
 * Пример: открыто 20:00, закрыто 11:00 следующего дня, окно 09:00–21:00 ->
 * 1ч вечером + 2ч утром = 3 часа.
 */
export function workingSecondsBetween(
  openedAt: Date,
  closedAt: Date,
  workStartHour: number,
  workEndHour: number,
  tzOffsetMinutes: number,
): number {
  const startMs = openedAt.getTime();
  const endMs = closedAt.getTime();
  if (endMs <= startMs) return 0;
  // Некорректное окно -> считаем всё время рабочим (fallback).
  if (!(workEndHour > workStartHour)) {
    return Math.round((endMs - startMs) / 1000);
  }

  const offsetMs = tzOffsetMinutes * 60_000;
  // Переводим в «локальное» псевдо-UTC время, чтобы сутки/часы считались в нужной TZ.
  const localStart = startMs + offsetMs;
  const localEnd = endMs + offsetMs;

  const dayMs = 86_400_000;
  const workStartMs = workStartHour * 3_600_000;
  const workEndMs = workEndHour * 3_600_000;

  let total = 0;
  for (
    let dayStart = Math.floor(localStart / dayMs) * dayMs;
    dayStart <= localEnd;
    dayStart += dayMs
  ) {
    const from = Math.max(dayStart + workStartMs, localStart);
    const to = Math.min(dayStart + workEndMs, localEnd);
    if (to > from) total += to - from;
  }
  return Math.round(total / 1000);
}

@Injectable()
export class MetricsService {
  constructor(private prisma: PrismaService) {}
  private workloadCache = new Map<
    string,
    {
      expiresAt: number;
      data: WorkloadEntry[];
    }
  >();
  private readonly workloadCacheTtlMs = 10_000;

  private get stuckHours(): number {
    return Number(process.env.STUCK_REVISION_HOURS) || 24;
  }

  async overview() {
    const totalOrders = await this.prisma.order.count();
    const totalRevisions = await this.prisma.revision.count();
    const openRevisions = await this.prisma.revision.count({
      where: { closure: { is: null } },
    });

    const stuckThreshold = new Date(Date.now() - this.stuckHours * 3600 * 1000);
    const stuckRevisions = await this.prisma.revision.count({
      where: {
        closure: { is: null },
        openedAt: { lt: stuckThreshold },
      },
    });

    const avgRevisionSeconds = await this.avgRevisionSeconds();

    // Эскизы: готовые (обе метки) и в работе (старт есть, готовности нет).
    const totalSketches = await this.prisma.order.count({
      where: { sketchStartedAt: { not: null }, sketchReadyAt: { not: null } },
    });
    const openSketches = await this.prisma.order.count({
      where: { sketchStartedAt: { not: null }, sketchReadyAt: null },
    });

    return {
      totalOrders,
      totalRevisions,
      avgRevisionSeconds,
      openRevisions,
      stuckRevisions,
      totalSketches,
      openSketches,
    };
  }

  async byDesigner() {
    const designers = await this.prisma.user.findMany({
      where: { role: 'DESIGNER' },
      select: { id: true, name: true },
    });

    const closures = await this.prisma.revisionClosure.findMany({
      select: { closedById: true, openedAt: true, closedAt: true },
    });

    return designers.map((d) => {
      const own = closures.filter((c) => c.closedById === d.id);
      const durations = own
        .map((c) => (c.closedAt.getTime() - c.openedAt.getTime()) / 1000)
        .filter((s) => s >= 0);
      const avg =
        durations.length > 0
          ? Math.round(durations.reduce((s, v) => s + v, 0) / durations.length)
          : null;
      return {
        designerId: d.id,
        name: d.name,
        revisions: own.length,
        avgRevisionSeconds: avg,
      };
    });
  }

  /**
   * Аналитика правок по «рабочему» времени закрытия.
   *
   * Считает среднее рабочее время закрытия правки по каждому дизайнеру, который
   * ЗАКРЫЛ правку (closedById), а также общее среднее по всем правкам.
   * На вход — суточное окно рабочего времени (часы) и часовой пояс.
   */
  async revisionAnalytics(params: {
    workStartHour?: number;
    workEndHour?: number;
    tzOffsetMinutes?: number;
  }) {
    const workStartHour = this.clampHour(params.workStartHour, DEFAULT_WORK_START_HOUR);
    const workEndHour = this.clampHour(params.workEndHour, DEFAULT_WORK_END_HOUR);
    const tzOffsetMinutes = Number.isFinite(params.tzOffsetMinutes)
      ? (params.tzOffsetMinutes as number)
      : DEFAULT_TZ_OFFSET_MINUTES;

    const closures = await this.prisma.revisionClosure.findMany({
      select: {
        closedById: true,
        openedAt: true,
        closedAt: true,
        closedBy: { select: { id: true, name: true } },
      },
    });

    const byDesignerMap = new Map<
      number,
      { designerId: number; name: string; count: number; totalSeconds: number }
    >();
    let overallCount = 0;
    let overallTotalSeconds = 0;

    for (const c of closures) {
      const seconds = workingSecondsBetween(
        c.openedAt,
        c.closedAt,
        workStartHour,
        workEndHour,
        tzOffsetMinutes,
      );
      overallCount += 1;
      overallTotalSeconds += seconds;

      const entry = byDesignerMap.get(c.closedById) ?? {
        designerId: c.closedById,
        name: c.closedBy?.name ?? `#${c.closedById}`,
        count: 0,
        totalSeconds: 0,
      };
      entry.count += 1;
      entry.totalSeconds += seconds;
      byDesignerMap.set(c.closedById, entry);
    }

    const byDesigner = Array.from(byDesignerMap.values())
      .map((e) => ({
        designerId: e.designerId,
        name: e.name,
        count: e.count,
        avgWorkingSeconds: e.count > 0 ? Math.round(e.totalSeconds / e.count) : null,
      }))
      .sort((a, b) => (b.avgWorkingSeconds ?? 0) - (a.avgWorkingSeconds ?? 0));

    return {
      workStartHour,
      workEndHour,
      tzOffsetMinutes,
      overall: {
        count: overallCount,
        avgWorkingSeconds:
          overallCount > 0 ? Math.round(overallTotalSeconds / overallCount) : null,
      },
      byDesigner,
    };
  }

  /**
   * Аналитика эскизов по «рабочему» времени изготовления.
   *
   * Для каждого заказа, у которого проставлены обе метки (sketchStartedAt и
   * sketchReadyAt), считает рабочее время между ними и группирует по текущему
   * художнику эскиза (sketchDesignerId). Заказы без художника попадают в
   * отдельную строку «Без художника».
   */
  async sketchAnalytics(params: {
    workStartHour?: number;
    workEndHour?: number;
    tzOffsetMinutes?: number;
  }) {
    const workStartHour = this.clampHour(params.workStartHour, DEFAULT_WORK_START_HOUR);
    const workEndHour = this.clampHour(params.workEndHour, DEFAULT_WORK_END_HOUR);
    const tzOffsetMinutes = Number.isFinite(params.tzOffsetMinutes)
      ? (params.tzOffsetMinutes as number)
      : DEFAULT_TZ_OFFSET_MINUTES;

    const orders = await this.prisma.order.findMany({
      where: {
        sketchStartedAt: { not: null },
        sketchReadyAt: { not: null },
      },
      select: {
        sketchDesignerId: true,
        sketchStartedAt: true,
        sketchReadyAt: true,
        sketchDesigner: { select: { id: true, name: true } },
      },
    });

    // Эскизы «в работе»: старт проставлен, но готовности ещё нет.
    const inProgressCount = await this.prisma.order.count({
      where: { sketchStartedAt: { not: null }, sketchReadyAt: null },
    });

    const UNASSIGNED_ID = 0;
    const byDesignerMap = new Map<
      number,
      { designerId: number; name: string; count: number; totalSeconds: number }
    >();
    let overallCount = 0;
    let overallTotalSeconds = 0;

    for (const order of orders) {
      // where гарантирует not null, но TS этого не знает.
      if (!order.sketchStartedAt || !order.sketchReadyAt) continue;
      const seconds = workingSecondsBetween(
        order.sketchStartedAt,
        order.sketchReadyAt,
        workStartHour,
        workEndHour,
        tzOffsetMinutes,
      );
      overallCount += 1;
      overallTotalSeconds += seconds;

      const designerId = order.sketchDesigner?.id ?? UNASSIGNED_ID;
      const name = order.sketchDesigner?.name ?? 'Без художника';
      const entry = byDesignerMap.get(designerId) ?? {
        designerId,
        name,
        count: 0,
        totalSeconds: 0,
      };
      entry.count += 1;
      entry.totalSeconds += seconds;
      byDesignerMap.set(designerId, entry);
    }

    const byDesigner = Array.from(byDesignerMap.values())
      .map((e) => ({
        designerId: e.designerId,
        name: e.name,
        count: e.count,
        avgWorkingSeconds: e.count > 0 ? Math.round(e.totalSeconds / e.count) : null,
      }))
      .sort((a, b) => (b.avgWorkingSeconds ?? 0) - (a.avgWorkingSeconds ?? 0));

    return {
      workStartHour,
      workEndHour,
      tzOffsetMinutes,
      inProgressCount,
      overall: {
        count: overallCount,
        avgWorkingSeconds:
          overallCount > 0 ? Math.round(overallTotalSeconds / overallCount) : null,
      },
      byDesigner,
    };
  }

  private clampHour(value: number | undefined, fallback: number): number {
    if (value === undefined || !Number.isFinite(value)) return fallback;
    return Math.min(Math.max(Math.trunc(value), 0), 24);
  }

  async workload(orderStatusIdsRaw?: string) {
    const orderStatusIds = this.parseStatusIds(orderStatusIdsRaw);
    const cacheKey = orderStatusIds.join(',');
    const now = Date.now();
    const cached = this.workloadCache.get(cacheKey);
    if (cached && cached.expiresAt > now) {
      return cached.data;
    }

    const statusWhere = this.buildOrderStatusWhere(orderStatusIds);
    const sketchWhere = { sketchDesignerId: { not: null }, ...statusWhere };
    const revisionWhere = { revisionDesignerId: { not: null }, ...statusWhere };
    // Менеджеры теперь приходят из BlueSales как имена — группируем по ним.
    const deliveryWhere = { deliveryManagerName: { not: null }, ...statusWhere };
    const onboardingWhere = { onboardingManagerName: { not: null }, ...statusWhere };

    const [designers, sketchCounts, revisionCounts, deliveryCounts, onboardingCounts] =
      await Promise.all([
        this.prisma.user.findMany({
          where: { role: Role.DESIGNER },
          select: { id: true, name: true, username: true, role: true },
          orderBy: [{ name: 'asc' }],
        }),
        this.prisma.order.groupBy({
          by: ['sketchDesignerId'],
          where: sketchWhere,
          _count: { _all: true },
        }),
        this.prisma.order.groupBy({
          by: ['revisionDesignerId'],
          where: revisionWhere,
          _count: { _all: true },
        }),
        this.prisma.order.groupBy({
          by: ['deliveryManagerName'],
          where: deliveryWhere,
          _count: { _all: true },
        }),
        this.prisma.order.groupBy({
          by: ['onboardingManagerName'],
          where: onboardingWhere,
          _count: { _all: true },
        }),
      ]);

    const sketchByUser = this.toCountMap(sketchCounts, 'sketchDesignerId');
    const revisionByUser = this.toCountMap(revisionCounts, 'revisionDesignerId');
    const openRevisionByUser = await this.fetchOpenRevisionByUser(orderStatusIds);

    // Дизайнеры — локальные пользователи (по FK-назначениям).
    const designerData: WorkloadEntry[] = designers.map((user) => ({
      userId: user.id,
      name: user.name,
      username: user.username,
      role: user.role,
      deliveryOrders: 0,
      onboardingOrders: 0,
      sketchOrders: sketchByUser.get(user.id) ?? 0,
      revisionOrders: revisionByUser.get(user.id) ?? 0,
      revisionOrdersWithOpenRequest: openRevisionByUser.get(user.id) ?? 0,
    }));

    // Менеджеры — из имён BlueSales (нет локального userId/username).
    const deliveryByName = this.toNameCountMap(deliveryCounts, 'deliveryManagerName');
    const onboardingByName = this.toNameCountMap(onboardingCounts, 'onboardingManagerName');
    const managerNames = Array.from(
      new Set([...deliveryByName.keys(), ...onboardingByName.keys()]),
    ).sort((a, b) => a.localeCompare(b, 'ru'));
    const managerData: WorkloadEntry[] = managerNames.map((name) => ({
      userId: 0,
      name,
      username: '',
      role: Role.MANAGER,
      deliveryOrders: deliveryByName.get(name) ?? 0,
      onboardingOrders: onboardingByName.get(name) ?? 0,
      sketchOrders: 0,
      revisionOrders: 0,
      revisionOrdersWithOpenRequest: 0,
    }));

    const data: WorkloadEntry[] = [...managerData, ...designerData];

    this.workloadCache.set(cacheKey, {
      data,
      expiresAt: now + this.workloadCacheTtlMs,
    });
    return data;
  }

  private async avgRevisionSeconds(): Promise<number | null> {
    const closures = await this.prisma.revisionClosure.findMany({
      select: { openedAt: true, closedAt: true },
    });
    const durations = closures
      .map((c) => (c.closedAt.getTime() - c.openedAt.getTime()) / 1000)
      .filter((s) => s >= 0);
    if (durations.length === 0) {
      return null;
    }
    return Math.round(durations.reduce((s, v) => s + v, 0) / durations.length);
  }

  private toCountMap<
    T extends {
      _count: { _all: number };
    },
    K extends keyof T,
  >(rows: T[], key: K) {
    const map = new Map<number, number>();
    for (const row of rows) {
      const rawId = row[key];
      if (typeof rawId !== 'number') {
        continue;
      }
      map.set(rawId, row._count._all);
    }
    return map;
  }

  private toNameCountMap<
    T extends {
      _count: { _all: number };
    },
    K extends keyof T,
  >(rows: T[], key: K) {
    const map = new Map<string, number>();
    for (const row of rows) {
      const rawName = row[key];
      if (typeof rawName !== 'string') {
        continue;
      }
      const name = rawName.trim();
      if (name.length === 0) {
        continue;
      }
      map.set(name, (map.get(name) ?? 0) + row._count._all);
    }
    return map;
  }

  private buildOrderStatusWhere(orderStatusIds: number[]) {
    if (orderStatusIds.length === 0) {
      return {};
    }
    return {
      bluesalesInfo: {
        is: {
          orderStatusId: { in: orderStatusIds },
        },
      },
    };
  }

  private parseStatusIds(raw?: string): number[] {
    if (!raw) return [];
    const ids = raw
      .split(',')
      .map((part) => Number(part.trim()))
      .filter((value) => Number.isInteger(value) && value >= 0);
    return Array.from(new Set(ids));
  }

  private async fetchOpenRevisionByUser(orderStatusIds: number[]) {
    const statusFilterSql =
      orderStatusIds.length > 0
        ? Prisma.sql`
          AND EXISTS (
            SELECT 1
            FROM "BluesalesOrderInfo" b
            WHERE b."orderId" = o."id"
              AND b."orderStatusId" IN (${Prisma.join(orderStatusIds)})
          )
        `
        : Prisma.empty;

    const rows = await this.prisma.$queryRaw<
      Array<{ userId: number; openRevisionOrders: bigint }>
    >`
      SELECT
        o."revisionDesignerId" AS "userId",
        COUNT(*) AS "openRevisionOrders"
      FROM "Order" o
      JOIN LATERAL (
        SELECT m."id"
        FROM "Message" m
        WHERE m."orderId" = o."id"
        ORDER BY m."createdAt" DESC, m."id" DESC
        LIMIT 1
      ) lm ON TRUE
      JOIN "Revision" rev ON rev."messageId" = lm."id"
      LEFT JOIN "RevisionClosure" rc ON rc."revisionId" = rev."id"
      WHERE o."revisionDesignerId" IS NOT NULL
        AND rc."id" IS NULL
        ${statusFilterSql}
      GROUP BY o."revisionDesignerId"
    `;
    const map = new Map<number, number>();
    for (const row of rows) {
      map.set(row.userId, Number(row.openRevisionOrders));
    }
    return map;
  }
}

interface WorkloadEntry {
  userId: number;
  name: string;
  username: string;
  role: Role;
  deliveryOrders: number;
  onboardingOrders: number;
  sketchOrders: number;
  revisionOrders: number;
  revisionOrdersWithOpenRequest: number;
}
