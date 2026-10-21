import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException, OnApplicationBootstrap, OnModuleDestroy, ServiceUnavailableException, StreamableFile } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { Prisma, ProductionFile } from '@prisma/client';
import { createHash, randomUUID } from 'crypto';
import { mkdtemp, rmdir, unlink } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from '../storage/storage.service';
import { StorageCleanupService } from '../storage/storage-cleanup.service';
import { productionOrderData } from './production-order-data';
import { ProductionParameters, renderProductionFile } from './production-file-renderer';
import { imageJobConfiguration } from '../storage/image-job.config';

const PRODUCTION_TEXT_SIZES = ['30x40', '40x60', '60x80'];

function textSize(value?: string): string {
  if (!value || value === 'standard') return '30x40';
  if (value === 'small') return '60x80';
  if (!PRODUCTION_TEXT_SIZES.includes(value)) throw new BadRequestException('Неизвестный размер текста для производства');
  return value;
}

@Injectable()
export class ProductionFilesService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(ProductionFilesService.name);
  private running = 0;
  private syncing = false;
  private stopping = false;
  private syncCursor = 0;
  private readonly concurrency = imageJobConfiguration().production;
  private readonly urgentDispatches = new Set<number>();

  constructor(private prisma: PrismaService, private storage: StorageService, private cleanup: StorageCleanupService) {}

  onApplicationBootstrap() {
    void this.synchronize();
    void this.processAvailable();
  }

  onModuleDestroy() { this.stopping = true; }

  private async context(orderId: number, attachmentId: number, client: Prisma.TransactionClient = this.prisma) {
    const order = await client.order.findUnique({
      where: { id: orderId }, select: {
        orderNumber: true,
        bluesalesInfo: { select: { rawPayload: true } },
      },
    });
    if (!order) throw new NotFoundException('Заказ не найден');
    const attachment = await client.attachment.findFirst({
      where: { id: attachmentId, printPhotoOrderId: orderId },
    });
    if (!attachment) throw new NotFoundException('Фото не прикреплено в разделе «Фото для печати» этого заказа');
    if (attachment.mimeType === 'application/pdf' || /\.(pdf|dng)$/i.test(attachment.filename)) {
      throw new BadRequestException('Для производства прикрепите растровое изображение вместо PDF или DNG');
    }
    // Match the order page's printPhotos order (id ASC), rather than the database ID.
    const photoNumber = await client.attachment.count({ where: { printPhotoOrderId: orderId, id: { lte: attachmentId } } });
    return { sourceKey: attachment.objectKey, parameters: productionOrderData.context(order.orderNumber, order.bluesalesInfo?.rawPayload, photoNumber) };
  }

  private fingerprint(sourceKey: string, parameters: ProductionParameters, size: string) {
    return createHash('sha256').update(JSON.stringify({ renderer: 'numbered-png-v3', sourceKey, parameters, textSize: size })).digest('hex');
  }

  /** Enqueue only: request handlers never decode an image or wait for its header. */
  async ensure(orderId: number, attachmentId: number, requestedSize?: string, retry = false, conflictAttempts = 0): Promise<ProductionFile> {
    const size = textSize(requestedSize);
    const identity = { orderId, attachmentId, textSize: size };
    try {
      return await this.prisma.$transaction(async (tx) => {
        const { sourceKey, parameters } = await this.context(orderId, attachmentId, tx);
        const fingerprint = this.fingerprint(sourceKey, parameters, size);
        const previous = await tx.productionFile.findUnique({ where: { orderId_attachmentId_textSize: identity } });
        if (previous?.fingerprint === fingerprint && !(retry && previous.status === 'failed')) return previous;
        if (previous?.objectKey) await this.cleanup.enqueue([previous.objectKey], tx,
          previous.status === 'processing' && previous.leaseUntil ? previous.leaseUntil : new Date());
        const input = {
          fingerprint, sourceKey, parameters: parameters as unknown as Prisma.InputJsonValue,
          status: 'pending', priority: 0, objectKey: null, size: null, attempts: 0,
          runToken: null, leaseUntil: null, nextAttemptAt: new Date(), error: null,
        };
        const job = await tx.productionFile.upsert({
          where: { orderId_attachmentId_textSize: identity }, create: { ...identity, ...input }, update: input,
        });
        // Record only actual enqueues, atomically with the job. Cache reads and
        // transaction retries must not inflate the debug counters.
        await tx.productionTaskEvent.create({ data: {
          ...identity, orderNumber: parameters.orderNumber,
          reason: !previous ? 'created' : previous.fingerprint !== fingerprint ? 'changed' : 'retry',
        } });
        return job;
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    } catch (error) {
      if (conflictAttempts < 3 && ['P2034', 'P2002'].includes(error.code)) {
        return this.ensure(orderId, attachmentId, requestedSize, retry, conflictAttempts + 1);
      }
      throw error;
    }
  }

  async status(orderId: number, attachmentId: number, size?: string, retry = false) {
    const job = await this.ensure(orderId, attachmentId, size, retry);
    return { status: job.status, size: job.size, expedited: job.priority > 0,
      message: job.status === 'failed' ? 'Не удалось подготовить файл. Повторите подготовку.' : null };
  }

  /** Persist urgency for this version only, and jump ahead of locally queued work. */
  async expedite(orderId: number, attachmentId: number, size?: string) {
    const job = await this.ensure(orderId, attachmentId, size, true);
    if (job.status === 'pending' || (job.status === 'processing' && job.leaseUntil && job.leaseUntil <= new Date())) {
      await this.prisma.productionFile.updateMany({
        where: { id: job.id, fingerprint: job.fingerprint, OR: [
          { status: 'pending' }, { status: 'processing', leaseUntil: { lte: new Date() } },
        ] },
        data: { priority: 1, nextAttemptAt: new Date() },
      });
      // A dedicated dispatch is necessary even when all background dispatchers
      // are waiting for shared slots. Actual rendering still obeys both limits.
      if (!this.urgentDispatches.has(job.id)) {
        this.urgentDispatches.add(job.id);
        void this.processNext(job.id).finally(() => this.urgentDispatches.delete(job.id));
      }
    }
    return this.status(orderId, attachmentId, size);
  }

  async download(orderId: number, attachmentId: number, size?: string) {
    const job = await this.ensure(orderId, attachmentId, size);
    if (job.status === 'failed') throw new BadRequestException('Не удалось подготовить файл для производства. Повторите подготовку');
    if (job.status !== 'ready' || !job.objectKey) throw new ConflictException('Файл для производства ещё готовится в фоне. Скачайте его после завершения подготовки');
    try {
      const stream = await this.storage.getStream(job.objectKey);
      const parameters = job.parameters as unknown as ProductionParameters;
      const filename = `production-${parameters.orderNumber.replace(/[^a-zA-Z0-9_-]/g, '_')}-${attachmentId}.png`;
      return new StreamableFile(stream, { type: 'image/png', disposition: `attachment; filename="${filename}"`, length: job.size ?? undefined });
    } catch (error) {
      this.logger.warn(`Скачивание файла производства #${job.id}: ${(error as Error).message}`);
      throw new ServiceUnavailableException('Подготовленный файл временно недоступен. Попробуйте ещё раз');
    }
  }

  /** Only explicit print photos get production variants; chat attachments never do. */
  async queueOrder(orderId: number, requestedSize?: string) {
    const preferred = textSize(requestedSize);
    const sizes = [preferred, ...PRODUCTION_TEXT_SIZES.filter((size) => size !== preferred)];
    const photos = await this.prisma.attachment.findMany({ where: { printPhotoOrderId: orderId }, select: { id: true, mimeType: true, filename: true } });
    for (const photo of photos) {
      if (photo.mimeType === 'application/pdf' || /\.(pdf|dng)$/i.test(photo.filename)) continue;
      for (const size of sizes) await this.ensure(orderId, photo.id, size);
    }
  }

  /** Call inside the same transaction that removes photos/order or unpins a sketch. */
  async scheduleDeletion(tx: Prisma.TransactionClient, where: Prisma.ProductionFileWhereInput) {
    const files = await tx.productionFile.findMany({ where, select: { objectKey: true, status: true, leaseUntil: true } });
    // Keep deletion durable until an in-flight upload can finish, even if its process
    // crashes immediately after writing the object. A surviving worker expedites it.
    for (const file of files) await this.cleanup.enqueue([file.objectKey], tx,
      file.status === 'processing' && file.leaseUntil ? file.leaseUntil : new Date());
    await tx.productionFile.deleteMany({ where });
  }

  @Interval(30_000)
  async synchronize() {
    if (this.syncing || this.stopping) return;
    this.syncing = true;
    try {
      const photos = await this.prisma.attachment.findMany({
        where: { printPhotoOrderId: { not: null }, id: { gt: this.syncCursor } },
        orderBy: { id: 'asc' }, take: 50, select: { id: true, printPhotoOrderId: true },
      });
      this.syncCursor = photos.length === 50 ? photos[photos.length - 1].id : 0;
      for (const orderId of new Set(photos.map((photo) => photo.printPhotoOrderId!))) {
        if (this.stopping) break;
        await this.queueOrder(orderId);
      }
    } catch (error) {
      this.logger.warn(`Очередь производства будет синхронизирована позже: ${(error as Error).message}`);
    } finally { this.syncing = false; }
  }

  @Interval(1000)
  async processAvailable() {
    if (this.stopping) return;
    const available = Math.max(0, this.concurrency - this.running);
    await Promise.allSettled(Array.from({ length: available }, () => this.processNext()));
  }

  async processNext(urgentJobId?: number) {
    if ((urgentJobId === undefined && this.running >= this.concurrency) || this.stopping) return;
    this.running++;
    try {
      // Share the expensive image slots with thumbnail generation.
      await this.storage.runImageJob(async () => {
        // Concurrent consumers may initially read the same row. Retry a lost claim.
        for (let attempt = 0; attempt < this.concurrency && !this.stopping; attempt++) {
          const now = new Date();
          const row = await this.prisma.productionFile.findFirst({ where: { ...(urgentJobId === undefined ? {} : { id: urgentJobId }), OR: [
            { status: 'pending', nextAttemptAt: { lte: now } },
            { status: 'processing', leaseUntil: { lte: now } },
          ] }, orderBy: [{ priority: 'desc' }, { createdAt: 'asc' }, { id: 'asc' }] });
          if (!row) return;
          const runToken = randomUUID();
          const objectKey = `production/${row.orderId}/${row.attachmentId}/${row.textSize}/${runToken}.png`;
          const claimed = await this.prisma.$transaction(async (tx) => {
            const result = await tx.productionFile.updateMany({
              where: { id: row.id, updatedAt: row.updatedAt, status: row.status, runToken: row.runToken },
              data: { status: 'processing', runToken, objectKey, leaseUntil: new Date(Date.now() + 10 * 60_000), attempts: { increment: 1 } },
            });
            if (!result.count) return false;
            if (row.objectKey) await this.cleanup.enqueue([row.objectKey], tx);
            return true;
          });
          if (claimed) {
            return this.prepare({ ...row, runToken, objectKey, attempts: row.attempts + 1 });
          }
        }
      }, urgentJobId !== undefined);
    } catch (error) {
      this.logger.warn(`Подготовка производства отложена: ${(error as Error).message}`);
    } finally { this.running--; }
  }

  private async prepare(job: ProductionFile) {
    const directory = await mkdtemp(join(tmpdir(), 'metalica-production-'));
    const source = join(directory, 'source');
    const destination = join(directory, 'production.png');
    const claim = { id: job.id, runToken: job.runToken, fingerprint: job.fingerprint, status: 'processing' };
    try {
      // Revalidate before downloading/decoding: old queued chat sketches and
      // photos removed while waiting must not consume production conversions.
      const before = await this.context(job.orderId, job.attachmentId);
      if (this.fingerprint(before.sourceKey, before.parameters, job.textSize) !== job.fingerprint) {
        await this.ensure(job.orderId, job.attachmentId, job.textSize);
        return false;
      }
      if (job.attempts > 3) throw new Error('Исчерпаны попытки подготовки');
      await this.storage.downloadToFile(job.sourceKey, source);
      await renderProductionFile(source, destination, job.parameters as unknown as ProductionParameters, job.textSize);
      const current = await this.context(job.orderId, job.attachmentId);
      if (this.fingerprint(current.sourceKey, current.parameters, job.textSize) !== job.fingerprint) {
        await this.ensure(job.orderId, job.attachmentId, job.textSize);
        return false;
      }
      // Unique key per claim prevents an old worker from deleting a newer result.
      const size = await this.storage.uploadPreparedFile(job.objectKey!, destination);
      const result = await this.prisma.productionFile.updateMany({ where: claim,
        data: { status: 'ready', size, runToken: null, leaseUntil: null, error: null } });
      if (!result.count) await this.cleanup.enqueue([job.objectKey]);
      return result.count > 0;
    } catch (error) {
      this.logger.warn(`Файл производства #${job.id}: ${(error as Error).message}`);
      // The claimed key was recorded before upload; even a crash leaves a cleanup trail.
      await this.prisma.$transaction(async (tx) => {
        await this.cleanup.enqueue([job.objectKey], tx);
        if (error instanceof NotFoundException) await tx.productionFile.deleteMany({ where: claim });
        else await tx.productionFile.updateMany({ where: claim, data: {
          status: job.attempts >= 3 ? 'failed' : 'pending', objectKey: null, size: null,
          runToken: null, leaseUntil: null, nextAttemptAt: new Date(Date.now() + 5000 * job.attempts),
          error: (error as Error).message.slice(0, 1000),
        } });
      });
      return false;
    } finally {
      await unlink(source).catch(() => undefined);
      await unlink(destination).catch(() => undefined);
      await rmdir(directory).catch(() => undefined);
    }
  }
}
