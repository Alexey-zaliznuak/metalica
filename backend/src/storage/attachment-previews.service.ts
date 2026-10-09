import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from './storage.service';

@Injectable()
export class AttachmentPreviewsService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(AttachmentPreviewsService.name);
  private running = false;
  private stopping = false;

  constructor(private prisma: PrismaService, private storage: StorageService) {}

  onApplicationBootstrap() {
    void this.processBatch();
  }

  onModuleDestroy() {
    this.stopping = true;
  }

  /** Durable backfill also retries previews whose storage write failed on upload. */
  @Interval(5000)
  async processBatch() {
    if (this.running || this.stopping) return;
    this.running = true;
    try {
      const attachments = await this.prisma.attachment.findMany({
        where: { previewStatus: 'pending' },
        orderBy: { id: 'asc' },
        take: 5,
      });
      const processedKeys = new Set<string>();
      for (const attachment of attachments) {
        if (this.stopping) break;
        if (processedKeys.has(attachment.objectKey)) continue;
        try {
          const previews = await this.storage.ensureImagePreviews(attachment.objectKey);
          // One original may be referenced by more than one attachment.
          await this.prisma.attachment.updateMany({
            where: { objectKey: attachment.objectKey, previewStatus: 'pending' },
            data: previews,
          });
          processedKeys.add(attachment.objectKey);
        } catch (error) {
          this.logger.warn(`Превью вложения #${attachment.id}: ${(error as Error).message}`);
          await this.prisma.attachment.updateMany({
            where: { id: attachment.id, previewStatus: 'pending' },
            data: {
              previewAttempts: { increment: 1 },
              ...(attachment.previewAttempts >= 2 ? { previewStatus: 'failed' } : {}),
            },
          });
        }
      }
    } catch (error) {
      this.logger.warn(`Обработка превью отложена: ${(error as Error).message}`);
    } finally {
      this.running = false;
    }
  }
}
