import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from './storage.service';

@Injectable()
export class StorageCleanupService {
  private readonly logger = new Logger(StorageCleanupService.name);
  private running = false;

  constructor(private prisma: PrismaService, private storage: StorageService) {}

  async enqueue(keys: (string | null | undefined)[], client: Prisma.TransactionClient = this.prisma, notBefore = new Date()) {
    const objectKeys = [...new Set(keys.filter((key): key is string => !!key))];
    for (const objectKey of objectKeys) await client.storedFileDeletion.upsert({
      where: { objectKey }, create: { objectKey, nextAttemptAt: notBefore },
      // A late upload can request deletion while an earlier cleanup is still running.
      update: { generation: { increment: 1 }, attempts: 0, nextAttemptAt: notBefore },
    });
  }

  @Interval(5000)
  async processBatch() {
    if (this.running) return;
    this.running = true;
    try {
      const rows = await this.prisma.storedFileDeletion.findMany({
        where: { nextAttemptAt: { lte: new Date() } }, orderBy: { createdAt: 'asc' }, take: 20,
      });
      for (const row of rows) {
        try {
          await this.storage.removeStoredObject(row.objectKey);
          await this.prisma.storedFileDeletion.deleteMany({ where: { objectKey: row.objectKey, generation: row.generation } });
        } catch (error) {
          this.logger.warn(`Удаление "${row.objectKey}" отложено: ${(error as Error).message}`);
          await this.prisma.storedFileDeletion.updateMany({
            where: { objectKey: row.objectKey, generation: row.generation },
            data: { attempts: { increment: 1 }, nextAttemptAt: new Date(Date.now() + Math.min(300_000, 5000 * 2 ** Math.min(row.attempts, 6))) },
          });
        }
      }
    } catch (error) {
      this.logger.warn(`Очистка хранилища отложена: ${(error as Error).message}`);
    } finally {
      this.running = false;
    }
  }
}
