-- CreateEnum
CREATE TYPE "OrderStatusChangeState" AS ENUM ('PENDING', 'PROCESSING', 'RETRY', 'SUCCEEDED');

-- AlterTable
ALTER TABLE "BluesalesOrderInfo" ADD COLUMN     "orderStatusObservedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "OrderStatusChange" (
    "id" SERIAL NOT NULL,
    "orderId" INTEGER NOT NULL,
    "actorId" INTEGER,
    "fromStatusId" INTEGER,
    "fromStatusName" TEXT,
    "toStatusId" INTEGER NOT NULL,
    "toStatusName" TEXT NOT NULL,
    "state" "OrderStatusChangeState" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lockedAt" TIMESTAMP(3),
    "leaseToken" TEXT,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "OrderStatusChange_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "OrderStatusChange_state_nextAttemptAt_idx" ON "OrderStatusChange"("state", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "OrderStatusChange_orderId_state_id_idx" ON "OrderStatusChange"("orderId", "state", "id");

-- CreateIndex
CREATE INDEX "OrderStatusChange_actorId_idx" ON "OrderStatusChange"("actorId");

-- AddForeignKey
ALTER TABLE "OrderStatusChange" ADD CONSTRAINT "OrderStatusChange_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderStatusChange" ADD CONSTRAINT "OrderStatusChange_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
