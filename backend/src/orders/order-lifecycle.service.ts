import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { StorageCleanupService } from '../storage/storage-cleanup.service';
import { ProductionFilesService } from './production-files.service';
import { OrdersService } from './orders.service';
import { CLEANUP_DELAY_MS, CLEANUP_TAG, COMPLETE_TAG, LIFECYCLE_STATUSES, lifecycleEligible } from './order-lifecycle.policy';
import { imagePreviewKeys } from '../storage/image-preview';

@Injectable()
export class OrderLifecycleService {
  private readonly logger = new Logger(OrderLifecycleService.name);
  private cursors = new Map<string, number>();
  private actionCursors = new Map<string, number>();
  constructor(private prisma: PrismaService, private cleanup: StorageCleanupService,
    private production: ProductionFilesService, private orders: OrdersService) {}

  async tick(kind: string, enabled: boolean) {
    const completion = kind === COMPLETE_TAG;
    const rows = await this.prisma.bluesalesOrderInfo.findMany({
      where: { orderId: { gt: this.cursors.get(kind) ?? 0 } }, orderBy: { orderId: 'asc' }, take: 100,
      select: { orderId: true },
    });
    for (const row of rows) {
      try { const event = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "orderId" FROM "BluesalesOrderInfo" WHERE "orderId" = ${row.orderId} FOR UPDATE`;
      const info = await tx.bluesalesOrderInfo.findUnique({ where: { orderId: row.orderId }, include: { order: { select: { orderNumber: true } } } });
      if (!info) return;
      const context = { orderId: row.orderId, orderNumber: info.order.orderNumber, kind,
        tagName: completion ? 'Будет завершён' : 'Вложения удалены' };
      if (lifecycleEligible(info.orderStatusId, info.rawPayload, new Date(), completion)) {
        const previous = await tx.orderSystemTag.findUnique({ where: { orderId_kind: { orderId: row.orderId, kind } } });
        const tag = await tx.orderSystemTag.upsert({ where: { orderId_kind: { orderId: row.orderId, kind } },
          create: { orderId: row.orderId, kind }, update: {} });
        if (!completion && tag?.completedAt && await tx.attachment.count({
          where: { OR: [{ printPhotoOrderId: row.orderId }, { message: { orderId: row.orderId } }] },
        })) {
          const markedAt = new Date();
          await tx.orderSystemTag.update({ where: { id: tag.id }, data: { markedAt, completedAt: null } });
          await tx.orderEvent.create({ data: { orderId: row.orderId, field: 'attachmentCleanupRearmed',
            oldValue: tag.markedAt.toISOString(), newValue: markedAt.toISOString(),
            meta: { previousCompletedAt: tag.completedAt.toISOString() } } });
          return { event: 'tag_rearmed', ...context, markedAt, scheduledAt: new Date(markedAt.getTime() + CLEANUP_DELAY_MS), actionEnabled: enabled };
        }
        if (!previous) return { event: 'tag_added', ...context, markedAt: tag.markedAt,
          scheduledAt: completion ? null : new Date(tag.markedAt.getTime() + CLEANUP_DELAY_MS), actionEnabled: enabled };
      } else {
        // Re-entering eligibility starts a fresh grace period. Completed tags retain history.
        const removed = await tx.orderSystemTag.deleteMany({ where: { orderId: row.orderId, kind, completedAt: null } });
        if (removed.count) return { event: 'tag_removed', ...context, reason: 'no_longer_eligible' };
      }
      });
      // Only report committed changes, never rolled-back attempts.
      if (event) this.logger.log(`Lifecycle ${JSON.stringify(event)}`);
      } catch (error) {
        this.logger.warn(`Lifecycle marking order #${row.orderId}: ${(error as Error).message}`);
      }
    }
    this.cursors.set(kind, rows.length === 100 ? rows[rows.length - 1].orderId : 0);
    this.logger.log(`Lifecycle ${JSON.stringify({ event: 'scan_completed', kind, checked: rows.length, nextOrderId: this.cursors.get(kind), actionEnabled: enabled })}`);
    if (!enabled) return;
    const tags = await this.prisma.orderSystemTag.findMany({
      where: { kind, completedAt: null, id: { gt: this.actionCursors.get(kind) ?? 0 },
        ...(completion ? {} : { markedAt: { lt: new Date(Date.now() - CLEANUP_DELAY_MS) } }) },
      orderBy: { id: 'asc' }, take: 100,
    });
    for (const tag of tags) {
      try {
      if (completion) {
        const info = await this.prisma.bluesalesOrderInfo.findUnique({ where: { orderId: tag.orderId } });
        if (!info || !lifecycleEligible(info.orderStatusId, info.rawPayload, new Date(), true)) continue;
        await this.orders.updateOrderStatus(tag.orderId, LIFECYCLE_STATUSES.delivered, undefined, info.orderStatusId!);
        const current = await this.prisma.bluesalesOrderInfo.findUnique({ where: { orderId: tag.orderId } });
        if (current?.orderStatusId === LIFECYCLE_STATUSES.delivered) await this.prisma.orderSystemTag.updateMany({ where: { id: tag.id, completedAt: null }, data: { completedAt: new Date() } });
      } else await this.deleteBatch(tag.id, tag.orderId);
      } catch (error) {
        this.logger.warn(`Lifecycle action order #${tag.orderId}: ${(error as Error).message}`);
      }
    }
    this.actionCursors.set(kind, tags.length === 100 ? tags[tags.length - 1].id : 0);
  }

  private async deleteBatch(tagId: number, orderId: number) {
    const result = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "orderId" FROM "BluesalesOrderInfo" WHERE "orderId" = ${orderId} FOR UPDATE`;
      const info = await tx.bluesalesOrderInfo.findUnique({ where: { orderId }, include: { order: { select: { orderNumber: true } } } });
      const tag = await tx.orderSystemTag.findUnique({ where: { id: tagId } });
      if (!info || !tag || tag.completedAt || tag.markedAt.getTime() >= Date.now() - CLEANUP_DELAY_MS || !lifecycleEligible(info.orderStatusId, info.rawPayload)) return;
      const where = { OR: [{ printPhotoOrderId: orderId }, { message: { orderId } }] };
      const attachments = await tx.attachment.findMany({ where, orderBy: { id: 'asc' }, take: 100 });
      const ids = attachments.map((a) => a.id);
      const context = { orderId, orderNumber: info.order.orderNumber };
      await this.production.scheduleDeletion(tx, { attachmentId: { in: ids } }, context);
      await tx.attachment.deleteMany({ where: { id: { in: ids } } });
      for (const attachment of attachments) {
        if (await tx.attachment.count({ where: { objectKey: attachment.objectKey } })) continue;
        const derived = imagePreviewKeys(attachment.objectKey);
        await this.cleanup.enqueue([attachment.objectKey, attachment.thumbnailKey, attachment.previewKey, ...Object.values(derived)], tx,
          attachment.previewStatus === 'pending' ? new Date(Date.now() + 10 * 60_000) : new Date(), context);
      }
      const remainingAttachments = await tx.attachment.count({ where });
      if (!remainingAttachments) await tx.orderSystemTag.update({ where: { id: tagId }, data: { completedAt: new Date() } });
      return { event: 'cleanup_queued', ...context, attachmentsRemoved: ids.length, remainingAttachments, s3Status: 'queued' };
    }, { timeout: 30_000 });
    if (result) this.logger.log(`Lifecycle ${JSON.stringify(result)}`);
  }
}
