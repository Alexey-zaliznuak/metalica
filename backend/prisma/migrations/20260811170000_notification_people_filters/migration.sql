-- AlterTable: replace onlyIfResponsible with people filters (like orders board)
ALTER TABLE "UserOrderStatusNotification" DROP COLUMN IF EXISTS "onlyIfResponsible";

ALTER TABLE "UserOrderStatusNotification" ADD COLUMN "deliveryManagerNames" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "UserOrderStatusNotification" ADD COLUMN "onboardingManagerNames" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "UserOrderStatusNotification" ADD COLUMN "sketchDesignerNames" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "UserOrderStatusNotification" ADD COLUMN "revisionDesignerNames" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
