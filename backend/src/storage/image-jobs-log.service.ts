import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from './storage.service';

@Injectable()
export class ImageJobsLogService implements OnModuleDestroy {
  private readonly logger = new Logger(ImageJobsLogService.name);
  private running = false;
  private stopping = false;

  constructor(private prisma: PrismaService, private storage: StorageService) {}

  onModuleDestroy() { this.stopping = true; }

  @Interval(10_000)
  async logCounts() {
    if (this.running || this.stopping) return;
    this.running = true;
    try {
      const [previews, production] = await Promise.all([
        // A shared original needs one pair of previews, regardless of attachment count.
        this.prisma.$queryRaw<Array<{ status: string; count: number }>>`
          SELECT "previewStatus" AS status, COUNT(DISTINCT "objectKey")::int AS count
          FROM "Attachment" GROUP BY "previewStatus"
        `,
        this.prisma.productionFile.groupBy({ by: ['status'], _count: { _all: true } }),
      ]);
      if (this.stopping) return;
      const previewCounts = new Map(previews.map((row) => [row.status, row.count]));
      const productionCounts = new Map(production.map((row) => [row.status, row._count._all]));
      const queue = this.storage.imageQueueSnapshot();
      const states = (counts: Map<string, number>, names: string[]) => names
        .map((name) => `${name}=${counts.get(name) ?? 0}`).join(', ');
      const local = (counts: { waiting: number; running: number }) => `ожидают=${counts.waiting}, выполняются=${counts.running}`;
      this.logger.log(
        `Задания изображений | превью БД: ${states(previewCounts, ['pending', 'ready', 'failed', 'unavailable'])}` +
        ` | производство БД: ${states(productionCounts, ['pending', 'processing', 'ready', 'failed'])}` +
        ` | операции текущего процесса: превью (${local(queue.preview)}), производство (${local(queue.production)})`,
      );
    } catch (error) {
      this.logger.warn(`Не удалось подсчитать задания изображений: ${(error as Error).message}`);
    } finally { this.running = false; }
  }
}
