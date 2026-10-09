import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { Attachment } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from './storage.service';
import { IMAGE_JOB_CONCURRENCY } from './image-preview';

@Injectable()
export class AttachmentPreviewsService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(AttachmentPreviewsService.name);
  private running = false;
  private readonly activeKeys = new Set<string>();
  private stopping = false;

  constructor(private prisma: PrismaService, private storage: StorageService) {}

  onApplicationBootstrap() {
    void this.processBatch();
  }

  onModuleDestroy() {
    this.stopping = true;
  }

  /** Durable backfill also retries previews whose storage write failed on upload. */
  @Interval(1000)
  async processBatch() {
    if (this.running || this.stopping) return;
    const available = IMAGE_JOB_CONCURRENCY - this.activeKeys.size;
    if (available <= 0) return;
    this.running = true;
    const jobs: Promise<void>[] = [];
    try {
      const attachments = await this.prisma.attachment.findMany({
        where: { previewStatus: 'pending', objectKey: { notIn: [...this.activeKeys] } },
        orderBy: { id: 'asc' },
        take: available,
      });
      for (const attachment of attachments) {
        if (this.stopping) break;
        if (this.activeKeys.has(attachment.objectKey)) continue;
        this.activeKeys.add(attachment.objectKey);
        jobs.push(this.processAttachment(attachment));
      }
    } catch (error) {
      this.logger.warn(`Обработка превью отложена: ${(error as Error).message}`);
    } finally {
      this.running = false;
    }
    // Release the dispatcher while workers run, so the next tick can refill free slots.
    const results = await Promise.allSettled(jobs);
    for (const result of results) if (result.status === 'rejected') {
      this.logger.warn(`Обработка превью отложена: ${(result.reason as Error).message}`);
    }
  }

  private async processAttachment(attachment: Attachment) {
    try {
      const previews = await this.storage.ensureImagePreviews(attachment.objectKey);
      // One original may be referenced by more than one attachment.
      await this.prisma.attachment.updateMany({
        where: { objectKey: attachment.objectKey, previewStatus: 'pending' }, data: previews,
      });
    } catch (error) {
      this.logger.warn(`Превью вложения #${attachment.id}: ${(error as Error).message}`);
      await this.prisma.attachment.updateMany({
        where: { id: attachment.id, previewStatus: 'pending' },
        data: {
          previewAttempts: { increment: 1 },
          ...(attachment.previewAttempts >= 2 ? { previewStatus: 'failed' } : {}),
        },
      });
    } finally { this.activeKeys.delete(attachment.objectKey); }
  }
}
