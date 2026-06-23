-- CreateEnum
CREATE TYPE "UserScope" AS ENUM ('orders.change_responsible');

-- AlterTable
ALTER TABLE "Order"
ADD COLUMN "deliveryManagerId" INTEGER,
ADD COLUMN "onboardingManagerId" INTEGER,
ADD COLUMN "revisionDesignerId" INTEGER,
ADD COLUMN "sketchDesignerId" INTEGER;

-- AlterTable
ALTER TABLE "User"
ADD COLUMN "scopes" "UserScope"[] DEFAULT ARRAY[]::"UserScope"[];

-- CreateIndex
CREATE INDEX "Order_deliveryManagerId_idx" ON "Order"("deliveryManagerId");

-- CreateIndex
CREATE INDEX "Order_onboardingManagerId_idx" ON "Order"("onboardingManagerId");

-- CreateIndex
CREATE INDEX "Order_sketchDesignerId_idx" ON "Order"("sketchDesignerId");

-- CreateIndex
CREATE INDEX "Order_revisionDesignerId_idx" ON "Order"("revisionDesignerId");

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_deliveryManagerId_fkey" FOREIGN KEY ("deliveryManagerId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_onboardingManagerId_fkey" FOREIGN KEY ("onboardingManagerId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_sketchDesignerId_fkey" FOREIGN KEY ("sketchDesignerId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_revisionDesignerId_fkey" FOREIGN KEY ("revisionDesignerId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
