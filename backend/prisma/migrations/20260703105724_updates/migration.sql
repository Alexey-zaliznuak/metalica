-- AlterTable
ALTER TABLE "BluesalesOrderInfo" ADD COLUMN     "bsCustomerId" INTEGER,
ADD COLUMN     "prepaymentSum" DOUBLE PRECISION;

-- AlterTable
ALTER TABLE "Lead" ADD COLUMN     "firstContactAt" TIMESTAMP(3),
ADD COLUMN     "marks" TEXT,
ADD COLUMN     "source" TEXT;

-- CreateIndex
CREATE INDEX "BluesalesOrderInfo_bsCustomerId_idx" ON "BluesalesOrderInfo"("bsCustomerId");
