import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { Prisma } from '@prisma/client';

const HOUR_MS = 3_600_000;
const SIZES = ['30x40', '40x60', '60x80'];
const emptyCounts = () => ({ newTasks: 0, changedTasks: 0, retriedTasks: 0,
  sizes: { '30x40': 0, '40x60': 0, '60x80': 0 } });

@Injectable()
export class ProductionTaskMetricsService {
  private readonly logger = new Logger(ProductionTaskMetricsService.name);

  constructor(private readonly prisma: PrismaService) {}

  async overview(now = new Date()) {
    const from = new Date(now.getTime() - HOUR_MS);
    const [events, queue] = await Promise.all([this.prisma.productionTaskEvent.findMany({
      where: { createdAt: { gte: from, lte: now } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: { orderId: true, orderNumber: true, attachmentId: true, textSize: true, reason: true, createdAt: true,
        cause: true, trigger: true, changes: true },
    }), this.currentQueue(now)]);
    type Event = { at: Date; textSize: string; reason: string; cause: string | null; trigger: string | null; changes: Prisma.JsonValue };
    type Photo = ReturnType<typeof emptyCounts> & { attachmentId: number; lastCreatedAt: Date; events: Event[] };
    const orders = new Map<number, {
      orderId: number; orderNumber: string; lastCreatedAt: Date; photos: Map<number, Photo>;
    }>();
    for (const event of events) {
      let order = orders.get(event.orderId);
      if (!order) {
        order = { orderId: event.orderId, orderNumber: event.orderNumber,
          lastCreatedAt: event.createdAt, photos: new Map() };
        orders.set(event.orderId, order);
      }
      let photo = order.photos.get(event.attachmentId);
      if (!photo) {
        photo = { attachmentId: event.attachmentId, lastCreatedAt: event.createdAt, events: [], ...emptyCounts() };
        order.photos.set(event.attachmentId, photo);
      }
      if (event.reason === 'created') {
        photo.newTasks++;
        if (SIZES.includes(event.textSize)) photo.sizes[event.textSize]++;
      } else if (event.reason === 'changed') photo.changedTasks++;
      else if (event.reason === 'retry') photo.retriedTasks++;
      photo.events.push({ at: event.createdAt, textSize: event.textSize, reason: event.reason,
        cause: event.cause, trigger: event.trigger, changes: event.changes });
    }
    const rows = [...orders.values()].map((order) => {
      const photos = [...order.photos.values()].sort((a, b) => a.attachmentId - b.attachmentId);
      const totals = emptyCounts();
      for (const photo of photos) {
        totals.newTasks += photo.newTasks;
        totals.changedTasks += photo.changedTasks;
        totals.retriedTasks += photo.retriedTasks;
        for (const size of SIZES) totals.sizes[size] += photo.sizes[size];
      }
      const newPhotos = photos.filter((photo) => photo.newTasks > 0);
      return { orderId: order.orderId, orderNumber: order.orderNumber, lastCreatedAt: order.lastCreatedAt,
        ...totals, newPhotos: newPhotos.length,
        completePhotoSets: newPhotos.filter((photo) => photo.newTasks === 3 && SIZES.every((size) => photo.sizes[size] === 1)).length,
        photos };
    }).sort((a, b) => (b.newTasks + b.changedTasks + b.retriedTasks) - (a.newTasks + a.changedTasks + a.retriedTasks)
      || b.lastCreatedAt.getTime() - a.lastCreatedAt.getTime() || a.orderId - b.orderId);
    const totals = rows.reduce((sum, row) => ({
      newTasks: sum.newTasks + row.newTasks, newPhotos: sum.newPhotos + row.newPhotos,
      changedTasks: sum.changedTasks + row.changedTasks, retriedTasks: sum.retriedTasks + row.retriedTasks,
    }), { newTasks: 0, newPhotos: 0, changedTasks: 0, retriedTasks: 0 });
    return { generatedAt: now, period: { from, to: now }, retentionDays: 7, totals, rows, queue };
  }

  private async currentQueue(now: Date) {
    // One read provides both the total and its breakdown. Lateral lookup recovers
    // known pre-upgrade reasons; missing historical evidence stays explicitly unknown.
    const jobs = await this.prisma.$queryRaw<Array<{
      id: number; orderId: number; orderNumber: string; attachmentId: number; textSize: string;
      status: string; attempts: number; error: string | null; createdAt: Date; queuedAt: Date | null;
      nextAttemptAt: Date; leaseUntil: Date | null; cause: string | null; trigger: string | null; changes: Prisma.JsonValue;
    }>>`
      SELECT p.id, p."orderId", o."orderNumber", p."attachmentId", p."textSize", p.status,
        p.attempts, p.error, p."createdAt", p."nextAttemptAt", p."leaseUntil",
        COALESCE(p."queuedAt", e."createdAt") AS "queuedAt",
        COALESCE(p."queueReason", e.cause, CASE e.reason
          WHEN 'changed' THEN 'data_change' WHEN 'retry' THEN 'manual_retry'
          WHEN 'created' THEN 'initial_unknown' END) AS cause,
        COALESCE(p."queueSource", e.trigger) AS trigger,
        COALESCE(p."queueChanges", e.changes) AS changes
      FROM "ProductionFile" p JOIN "Order" o ON o.id = p."orderId"
      LEFT JOIN LATERAL (
        SELECT reason, cause, trigger, changes, "createdAt" FROM "ProductionTaskEvent" e
        WHERE p."queuedAt" IS NULL AND e."orderId" = p."orderId" AND e."attachmentId" = p."attachmentId" AND e."textSize" = p."textSize"
        ORDER BY e."createdAt" DESC, e.id DESC LIMIT 1
      ) e ON true
      WHERE p.status IN ('pending', 'processing')
      ORDER BY COALESCE(p."queuedAt", e."createdAt", p."createdAt") ASC, p.id ASC
    `;
    const causes = new Map<string, number>();
    const rows = jobs.map((job) => {
      const cause = job.cause ?? 'legacy_unknown';
      const category = job.error ? 'automatic_retry' : cause;
      causes.set(category, (causes.get(category) ?? 0) + 1);
      return { ...job, cause, category, leaseExpired: job.status === 'processing' && !!job.leaseUntil && job.leaseUntil <= now };
    });
    return { total: rows.length, pending: rows.filter((row) => row.status === 'pending').length,
      processing: rows.filter((row) => row.status === 'processing').length,
      photos: new Set(rows.map((row) => row.attachmentId)).size,
      orders: new Set(rows.map((row) => row.orderId)).size,
      causes: [...causes].map(([cause, count]) => ({ cause, count })).sort((a, b) => b.count - a.count), rows };
  }

  @Interval(HOUR_MS)
  async prune() {
    try {
      await this.prisma.productionTaskEvent.deleteMany({ where: { createdAt: { lt: new Date(Date.now() - 7 * 24 * HOUR_MS) } } });
    } catch (error) {
      this.logger.warn(`Очистка журнала производства отложена: ${(error as Error).message}`);
    }
  }
}
