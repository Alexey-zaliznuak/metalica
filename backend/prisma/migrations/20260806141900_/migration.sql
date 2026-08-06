-- AlterTable
ALTER TABLE "BluesalesOrderInfo" ADD COLUMN     "orderStatusEnteredAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "BluesalesOrderStatus" ADD COLUMN     "alertAfterMinutes" INTEGER,
ADD COLUMN     "closesSketch" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "showTimeInStatus" BOOLEAN NOT NULL DEFAULT false;
