import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { DAY_MS, HOUR_MS, USAGE_TARGET_MS, USAGE_TIME_ZONE, usageDateKey, usageForecast, usagePeriodStart } from './bluesales-usage';

export interface SuccessfulBluesalesRequest {
  label: string;
  method: string;
  startedAt: Date;
  completedAt: Date;
  durationMs: number;
}

@Injectable()
export class BluesalesMetricsService {
  constructor(private readonly prisma: PrismaService) {}

  async recordSuccess(request: SuccessfulBluesalesRequest): Promise<void> {
    await this.prisma.bluesalesRequestMetric.create({ data: {
      ...request,
      label: request.label.trim().slice(0, 120) || request.method,
      durationMs: Math.max(1, Math.round(request.durationMs)),
      periodStart: usagePeriodStart(request.startedAt),
    } });
  }

  async overview(date?: string, now = new Date()) {
    const currentStart = usagePeriodStart(now);
    let start = currentStart;
    if (date !== undefined) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new BadRequestException('Дата должна быть в формате YYYY-MM-DD');
      start = new Date(`${date}T01:00:00+03:00`);
      if (!Number.isFinite(start.getTime()) || usageDateKey(start) !== date || start > currentStart) {
        throw new BadRequestException('Некорректная дата периода');
      }
    }
    const end = new Date(start.getTime() + DAY_MS);
    const recentFrom = new Date(Math.max(start.getTime(), now.getTime() - HOUR_MS));
    const groupsQuery = this.prisma.bluesalesRequestMetric.groupBy({
      by: ['label'], where: { periodStart: start },
      _sum: { durationMs: true }, _count: { _all: true }, _max: { durationMs: true },
    });
    const historyQuery = this.prisma.bluesalesRequestMetric.groupBy({
      by: ['periodStart'], orderBy: { periodStart: 'desc' }, take: 14,
      where: { periodStart: { gte: new Date(currentStart.getTime() - 13 * DAY_MS) } },
      _sum: { durationMs: true }, _count: { _all: true },
    });
    const [groups, hours, recent, first, history] = await this.prisma.$transaction([
      groupsQuery,
      this.prisma.$queryRaw<Array<{ hour: number; durationMs: number; count: number }>>`
        SELECT floor(extract(epoch FROM ("startedAt" - ${start}::timestamptz)) / 3600)::int AS hour,
               sum("durationMs")::float8 AS "durationMs", count(*)::int AS count
        FROM "BluesalesRequestMetric" WHERE "periodStart" = ${start}
        GROUP BY 1 ORDER BY 1`,
      this.prisma.bluesalesRequestMetric.aggregate({
        where: { periodStart: start, startedAt: { gte: recentFrom, lte: now } },
        _sum: { durationMs: true }, _count: { _all: true },
      }),
      this.prisma.bluesalesRequestMetric.findFirst({ orderBy: { startedAt: 'asc' }, select: { startedAt: true } }),
      historyQuery,
    ], { isolationLevel: 'RepeatableRead' });
    const labels = groups.map((row) => ({
      label: row.label, durationMs: row._sum.durationMs ?? 0, count: row._count._all,
      maxMs: row._max.durationMs ?? 0,
      averageMs: Math.round((row._sum.durationMs ?? 0) / row._count._all),
    })).sort((a, b) => b.durationMs - a.durationMs || a.label.localeCompare(b.label));
    const totalMs = labels.reduce((sum, row) => sum + row.durationMs, 0);
    const count = labels.reduce((sum, row) => sum + row.count, 0);
    let cumulativeMs = 0;
    const hourly = Array.from({ length: 24 }, (_, hour) => {
      const row = hours.find((item) => item.hour === hour);
      cumulativeMs += row?.durationMs ?? 0;
      return { at: new Date(start.getTime() + hour * HOUR_MS), durationMs: row?.durationMs ?? 0, count: row?.count ?? 0, cumulativeMs };
    });
    return {
      generatedAt: now, timeZone: USAGE_TIME_ZONE,
      period: { date: usageDateKey(start), start, end, isCurrent: start.getTime() === currentStart.getTime() },
      trackingSince: first?.startedAt ?? null,
      summary: { totalMs, count, averageMs: count ? Math.round(totalMs / count) : 0, targetMs: USAGE_TARGET_MS, remainingMs: Math.max(0, USAGE_TARGET_MS - totalMs) },
      labels, hourly,
      forecast: usageForecast({ now, periodStart: start, totalMs, recentMs: recent._sum.durationMs ?? 0, recentCount: recent._count._all, observedFrom: first?.startedAt ?? now }),
      history: history.map((row) => ({ date: usageDateKey(row.periodStart), durationMs: row._sum.durationMs ?? 0, count: row._count._all })),
    };
  }
}
