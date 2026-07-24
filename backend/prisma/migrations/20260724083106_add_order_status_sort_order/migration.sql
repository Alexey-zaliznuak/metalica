-- AlterTable
ALTER TABLE "BluesalesOrderStatus" ADD COLUMN     "sortOrder" INTEGER NOT NULL DEFAULT 0;

-- CreateIndex
CREATE INDEX "BluesalesOrderStatus_sortOrder_idx" ON "BluesalesOrderStatus"("sortOrder");
