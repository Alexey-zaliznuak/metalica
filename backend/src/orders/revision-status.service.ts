import { Logger } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';

// ID from the BlueSales status catalogue, independent of display-name changes.
export const REVISION_START_STATUS_ID = 174704;
export const REVISION_READY_STATUS_ID = 179920;

/** Caller holds the BluesalesOrderInfo row lock (or has just inserted the row).
 * Status and revision writes must use the same transaction. */
export async function trackRevisionStatusTransition(
  tx: Prisma.TransactionClient,
  orderId: number,
  previousStatusId: number | null,
  statusId: number | null,
  changedAt: Date,
): Promise<void> {
  if (previousStatusId === statusId) return;
  if (statusId === REVISION_START_STATUS_ID) {
    const active = await tx.revision.findFirst({
      where: { orderId, closure: { is: null } },
      select: { id: true },
    });
    if (!active) {
      await tx.revision.create({ data: { orderId, openedAt: changedAt } });
    }
  } else if (statusId === REVISION_READY_STATUS_ID) {
    const active = await tx.revision.findMany({
      where: { orderId, closure: { is: null } },
      select: { id: true, openedAt: true },
    });
    if (!active.length) return;
    const order = await tx.order.findUniqueOrThrow({
      where: { id: orderId },
      select: { revisionDesignerId: true },
    });
    await tx.revisionClosure.createMany({
      data: active.map((revision) => ({
        revisionId: revision.id,
        closedById: order.revisionDesignerId,
        openedAt: revision.openedAt,
        closedAt: new Date(Math.max(changedAt.getTime(), revision.openedAt.getTime())),
      })),
      skipDuplicates: true,
    });
  }
}

/** Restore missing active cycles before HTTP and background workers start.
 * Existing revisions (including legacy message links and dates) stay intact. */
export async function reconcileActiveRevisions(prisma: PrismaClient): Promise<void> {
  const logger = new Logger('RevisionStatusService');
  let cursor = 0;
  let restored = 0;
  for (;;) {
    const batch = await prisma.bluesalesOrderInfo.findMany({
      where: {
        orderId: { gt: cursor },
        orderStatusId: REVISION_START_STATUS_ID,
        order: { revisions: { none: { closure: { is: null } } } },
      },
      select: { orderId: true },
      orderBy: { orderId: 'asc' },
      take: 100,
    });
    if (!batch.length) break;
    for (const { orderId } of batch) {
      await prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT "orderId" FROM "BluesalesOrderInfo"
          WHERE "orderId" = ${orderId} FOR UPDATE`;
        const info = await tx.bluesalesOrderInfo.findUnique({ where: { orderId } });
        if (info?.orderStatusId !== REVISION_START_STATUS_ID) return;
        const active = await tx.revision.findFirst({
          where: { orderId, closure: { is: null } }, select: { id: true },
        });
        if (active) return;
        await trackRevisionStatusTransition(tx, orderId, null, info.orderStatusId,
          info.orderStatusEnteredAt ?? new Date());
        restored++;
      });
    }
    cursor = batch[batch.length - 1].orderId;
  }
  logger.log(`Active revision reconciliation completed: restored=${restored}`);
}
