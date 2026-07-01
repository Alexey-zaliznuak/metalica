import { Injectable } from '@nestjs/common';
import { MessageKind, Prisma, Role } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

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
    const totalRevisions = await this.prisma.message.count({
      where: { kind: MessageKind.REVISION_REQUEST },
    });
    const openRevisions = await this.prisma.message.count({
      where: { kind: MessageKind.REVISION_REQUEST, answeredBy: { none: {} } },
    });

    const stuckThreshold = new Date(Date.now() - this.stuckHours * 3600 * 1000);
    const stuckRevisions = await this.prisma.message.count({
      where: {
        kind: MessageKind.REVISION_REQUEST,
        answeredBy: { none: {} },
        createdAt: { lt: stuckThreshold },
      },
    });

    const avgRevisionSeconds = await this.avgRevisionSeconds();

    return { totalOrders, totalRevisions, avgRevisionSeconds, openRevisions, stuckRevisions };
  }

  async byDesigner() {
    const designers = await this.prisma.user.findMany({
      where: { role: 'DESIGNER' },
      select: { id: true, name: true },
    });

    const answers = await this.prisma.message.findMany({
      where: { kind: MessageKind.REVISION_ANSWER, answerToId: { not: null } },
      select: {
        authorId: true,
        createdAt: true,
        answerTo: { select: { createdAt: true } },
      },
    });

    return designers.map((d) => {
      const own = answers.filter((a) => a.authorId === d.id && a.answerTo);
      const durations = own
        .map((a) => (a.createdAt.getTime() - a.answerTo!.createdAt.getTime()) / 1000)
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
    const answers = await this.prisma.message.findMany({
      where: { kind: MessageKind.REVISION_ANSWER, answerToId: { not: null } },
      select: { createdAt: true, answerTo: { select: { createdAt: true } } },
    });
    const durations = answers
      .filter((a) => a.answerTo)
      .map((a) => (a.createdAt.getTime() - a.answerTo!.createdAt.getTime()) / 1000)
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
        SELECT m."kind"
        FROM "Message" m
        WHERE m."orderId" = o."id"
        ORDER BY m."createdAt" DESC, m."id" DESC
        LIMIT 1
      ) lm ON TRUE
      WHERE o."revisionDesignerId" IS NOT NULL
        AND lm."kind" = 'REVISION_REQUEST'::"MessageKind"
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
