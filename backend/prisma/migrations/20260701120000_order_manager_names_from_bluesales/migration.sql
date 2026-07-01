-- DropForeignKey
ALTER TABLE "Order" DROP CONSTRAINT IF EXISTS "Order_deliveryManagerId_fkey";
ALTER TABLE "Order" DROP CONSTRAINT IF EXISTS "Order_onboardingManagerId_fkey";

-- DropIndex
DROP INDEX IF EXISTS "Order_deliveryManagerId_idx";
DROP INDEX IF EXISTS "Order_onboardingManagerId_idx";

-- AlterTable: заменяем FK на менеджеров именами, приходящими из BlueSales
ALTER TABLE "Order" ADD COLUMN "deliveryManagerName" TEXT;
ALTER TABLE "Order" ADD COLUMN "onboardingManagerName" TEXT;

ALTER TABLE "Order" DROP COLUMN "deliveryManagerId";
ALTER TABLE "Order" DROP COLUMN "onboardingManagerId";

-- CreateIndex
CREATE INDEX "Order_deliveryManagerName_idx" ON "Order"("deliveryManagerName");
CREATE INDEX "Order_onboardingManagerName_idx" ON "Order"("onboardingManagerName");
