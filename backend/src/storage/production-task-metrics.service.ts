import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';

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
    const events = await this.prisma.productionTaskEvent.findMany({
      where: { createdAt: { gte: from, lte: now } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: { orderId: true, orderNumber: true, attachmentId: true, textSize: true, reason: true, createdAt: true },
    });
    type Photo = ReturnType<typeof emptyCounts> & { attachmentId: number; lastCreatedAt: Date };
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
        photo = { attachmentId: event.attachmentId, lastCreatedAt: event.createdAt, ...emptyCounts() };
        order.photos.set(event.attachmentId, photo);
      }
      if (event.reason === 'created') {
        photo.newTasks++;
        if (SIZES.includes(event.textSize)) photo.sizes[event.textSize]++;
      } else if (event.reason === 'changed') photo.changedTasks++;
      else if (event.reason === 'retry') photo.retriedTasks++;
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
    return { generatedAt: now, period: { from, to: now }, retentionDays: 7, totals, rows };
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
