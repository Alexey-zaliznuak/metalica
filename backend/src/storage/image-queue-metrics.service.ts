import { BadRequestException, Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from './storage.service';
import { completionSummary, IMAGE_QUEUE_HOUR_MS, IMAGE_QUEUE_RETENTION_HOURS, IMAGE_QUEUE_SAMPLE_MS, imageQueueBacklog, imageQueueEstimate } from './image-queue-metrics';

@Injectable()
export class ImageQueueMetricsService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(ImageQueueMetricsService.name);
  private sampling = false;
  private stopping = false;
  private lastSampleAt = Date.now();
  private lastCleanupAt = 0;

  constructor(private readonly prisma: PrismaService, private readonly storage: StorageService) {}

  onApplicationBootstrap() { void this.sample(); }
  onModuleDestroy() { this.stopping = true; }

  private async counts() {
    const [previews, production] = await Promise.all([
      this.prisma.$queryRaw<Array<{ status: string; count: number }>>`
        SELECT "previewStatus" AS status, COUNT(DISTINCT "objectKey")::int AS count
        FROM "Attachment" GROUP BY "previewStatus"
      `,
      this.prisma.productionFile.groupBy({ by: ['status'], _count: { _all: true } }),
    ]);
    const previewCounts = new Map(previews.map((row) => [row.status, row.count]));
    const productionCounts = new Map(production.map((row) => [row.status, row._count._all]));
    const backlog = imageQueueBacklog(previewCounts.get('pending') ?? 0, productionCounts.get('pending') ?? 0,
      productionCounts.get('processing') ?? 0, this.storage.imageQueueSnapshot());
    return {
      preview: { ...backlog.preview, ready: previewCounts.get('ready') ?? 0, failed: previewCounts.get('failed') ?? 0, unavailable: previewCounts.get('unavailable') ?? 0 },
      production: { ...backlog.production, ready: productionCounts.get('ready') ?? 0, failed: productionCounts.get('failed') ?? 0, unavailable: 0 },
    };
  }

  @Interval(IMAGE_QUEUE_SAMPLE_MS)
  async sample() {
    if (this.sampling || this.stopping) return;
    this.sampling = true;
    try {
      const counts = await this.counts();
      const now = Date.now();
      const measurements = this.storage.imageQueueMeasurements().filter((row) => row.completedAt > this.lastSampleAt && row.completedAt <= now);
      const preview = completionSummary(measurements, 'preview');
      const production = completionSummary(measurements, 'production');
      if (this.stopping) return;
      await this.prisma.imageQueueMetric.create({ data: {
        sampledAt: new Date(now), previewWaiting: counts.preview.waiting, previewRunning: counts.preview.running,
        productionWaiting: counts.production.waiting, productionRunning: counts.production.running,
        previewCompleted: preview.completed, productionCompleted: production.completed,
        previewDurationMs: preview.durationMs, productionDurationMs: production.durationMs,
        previewLastCompletedAt: preview.lastCompletedAt, productionLastCompletedAt: production.lastCompletedAt,
      } });
      this.lastSampleAt = now;
      if (now - this.lastCleanupAt >= IMAGE_QUEUE_HOUR_MS) {
        await this.prisma.imageQueueMetric.deleteMany({ where: { sampledAt: { lt: new Date(now - IMAGE_QUEUE_RETENTION_HOURS * IMAGE_QUEUE_HOUR_MS) } } });
        this.lastCleanupAt = now;
      }
    } catch (error) {
      this.logger.warn(`Не удалось сохранить метрики очереди изображений: ${(error as Error).message}`);
    } finally { this.sampling = false; }
  }

  async overview(hours?: string, now = new Date()) {
    const historyHours = hours === undefined ? 24 : Number(hours);
    if (!Number.isInteger(historyHours) || historyHours < 1 || historyHours > IMAGE_QUEUE_RETENTION_HOURS) {
      throw new BadRequestException('Период должен быть целым числом часов от 1 до 168');
    }
    // Capture one boundary before database I/O. A concurrent sampler may advance
    // lastSampleAt while this request is awaiting its history query.
    const sampleBoundary = this.lastSampleAt;
    const from = new Date(now.getTime() - historyHours * IMAGE_QUEUE_HOUR_MS);
    const [counts, rows] = await Promise.all([
      this.counts(),
      this.prisma.imageQueueMetric.findMany({ where: { sampledAt: { gte: from, lte: now } }, orderBy: { sampledAt: 'asc' } }),
    ]);
    const limits = this.storage.imageJobConfiguration();
    const measurements = this.storage.imageQueueMeasurements().filter((row) => row.completedAt > sampleBoundary && row.completedAt <= now.getTime());
    const localRecent = this.storage.imageQueueMeasurements().filter((row) => row.success && row.completedAt >= now.getTime() - 10 * 60_000 && row.completedAt <= now.getTime());
    const recent = rows.filter((row) => row.sampledAt.getTime() >= now.getTime() - IMAGE_QUEUE_HOUR_MS && row.sampledAt.getTime() <= sampleBoundary);
    const observedMs = Math.min(IMAGE_QUEUE_HOUR_MS, Math.max(IMAGE_QUEUE_SAMPLE_MS, now.getTime() - (recent[0]?.sampledAt.getTime() ?? sampleBoundary)));
    const estimate = (kind: 'preview' | 'production') => {
      const live = completionSummary(measurements, kind);
      return imageQueueEstimate({
        outstanding: counts[kind].waiting + counts[kind].running,
        completed: recent.reduce((sum, row) => sum + row[`${kind}Completed`], live.completed),
        durationMs: recent.reduce((sum, row) => sum + row[`${kind}DurationMs`], live.durationMs),
        concurrency: Math.min(limits.total, limits[kind]), observedMs,
        hasRecentLocalSuccess: localRecent.some((row) => row.kind === kind),
      });
    };
    const preview = { ...counts.preview, ...estimate('preview') };
    const production = { ...counts.production, ...estimate('production') };
    const queues = [preview, production];
    const totalWorkMs = queues.reduce((sum, row) => sum + (row.waiting + row.running) * (row.averageDurationMs ?? 0), 0);
    const etaSeconds = queues.some((row) => row.etaSeconds === null) ? null
      : Math.max(...queues.map((row) => row.etaSeconds ?? 0), Math.ceil(totalWorkMs / limits.total / 1000));
    // Bound graph payloads to roughly 720 buckets while preserving backlog peaks.
    const bucketMs = Math.max(IMAGE_QUEUE_SAMPLE_MS, Math.ceil(historyHours * IMAGE_QUEUE_HOUR_MS / 720));
    const history = new Map<number, { sampledAt: Date; previewWaiting: number; previewRunning: number; productionWaiting: number; productionRunning: number; previewCompleted: number; productionCompleted: number }>();
    for (const row of rows) {
      const key = Math.floor(row.sampledAt.getTime() / bucketMs);
      const point = history.get(key);
      if (!point) history.set(key, { sampledAt: row.sampledAt, previewWaiting: row.previewWaiting, previewRunning: row.previewRunning,
        productionWaiting: row.productionWaiting, productionRunning: row.productionRunning, previewCompleted: row.previewCompleted, productionCompleted: row.productionCompleted });
      else {
        point.sampledAt = row.sampledAt;
        point.previewWaiting = Math.max(point.previewWaiting, row.previewWaiting);
        point.previewRunning = Math.max(point.previewRunning, row.previewRunning);
        point.productionWaiting = Math.max(point.productionWaiting, row.productionWaiting);
        point.productionRunning = Math.max(point.productionRunning, row.productionRunning);
        point.previewCompleted += row.previewCompleted;
        point.productionCompleted += row.productionCompleted;
      }
    }
    const livePreview = completionSummary(measurements, 'preview');
    const liveProduction = completionSummary(measurements, 'production');
    return {
      sampledAt: now, historyHours, samplingIntervalSeconds: IMAGE_QUEUE_SAMPLE_MS / 1000, retentionHours: IMAGE_QUEUE_RETENTION_HOURS,
      concurrency: { ...limits, scope: 'process' as const }, preview, production, etaSeconds,
      estimateAssumption: 'no_new_jobs' as const, measurementScope: 'process' as const,
      history: [...history.values(), { sampledAt: now, previewWaiting: preview.waiting, previewRunning: preview.running,
        productionWaiting: production.waiting, productionRunning: production.running, previewCompleted: livePreview.completed, productionCompleted: liveProduction.completed }],
    };
  }
}
