import { Injectable } from '@nestjs/common';
import { MessageKind, Role } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class MetricsService {
  constructor(private prisma: PrismaService) {}
  private workloadCache: {
    expiresAt: number;
    data: WorkloadEntry[];
  } | null = null;
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

  async workload() {
    const now = Date.now();
    if (this.workloadCache && this.workloadCache.expiresAt > now) {
      return this.workloadCache.data;
    }

    const [users, deliveryCounts, onboardingCounts, sketchCounts, revisionCounts] =
      await Promise.all([
        this.prisma.user.findMany({
          where: { role: { in: [Role.MANAGER, Role.DESIGNER] } },
          select: { id: true, name: true, username: true, role: true },
          orderBy: [{ role: 'asc' }, { name: 'asc' }],
        }),
        this.prisma.order.groupBy({
          by: ['deliveryManagerId'],
          where: { deliveryManagerId: { not: null } },
          _count: { _all: true },
        }),
        this.prisma.order.groupBy({
          by: ['onboardingManagerId'],
          where: { onboardingManagerId: { not: null } },
          _count: { _all: true },
        }),
        this.prisma.order.groupBy({
          by: ['sketchDesignerId'],
          where: { sketchDesignerId: { not: null } },
          _count: { _all: true },
        }),
        this.prisma.order.groupBy({
          by: ['revisionDesignerId'],
          where: { revisionDesignerId: { not: null } },
          _count: { _all: true },
        }),
      ]);

    const deliveryByUser = this.toCountMap(deliveryCounts, 'deliveryManagerId');
    const onboardingByUser = this.toCountMap(onboardingCounts, 'onboardingManagerId');
    const sketchByUser = this.toCountMap(sketchCounts, 'sketchDesignerId');
    const revisionByUser = this.toCountMap(revisionCounts, 'revisionDesignerId');
    const openRevisionByUser = await this.fetchOpenRevisionByUser();

    const data = users.map((user) => ({
      userId: user.id,
      name: user.name,
      username: user.username,
      role: user.role,
      deliveryOrders: deliveryByUser.get(user.id) ?? 0,
      onboardingOrders: onboardingByUser.get(user.id) ?? 0,
      sketchOrders: sketchByUser.get(user.id) ?? 0,
      revisionOrders: revisionByUser.get(user.id) ?? 0,
      revisionOrdersWithOpenRequest: openRevisionByUser.get(user.id) ?? 0,
    }));

    this.workloadCache = {
      data,
      expiresAt: now + this.workloadCacheTtlMs,
    };
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

  private async fetchOpenRevisionByUser() {
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
