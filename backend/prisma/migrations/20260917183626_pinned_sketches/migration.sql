-- CreateTable
CREATE TABLE "OrderPinnedSketch" (
    "id" SERIAL NOT NULL,
    "orderId" INTEGER NOT NULL,
    "messageId" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OrderPinnedSketch_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "OrderPinnedSketch_orderId_createdAt_idx" ON "OrderPinnedSketch"("orderId", "createdAt");

-- CreateIndex
CREATE INDEX "OrderPinnedSketch_messageId_idx" ON "OrderPinnedSketch"("messageId");

-- CreateIndex
CREATE UNIQUE INDEX "OrderPinnedSketch_orderId_messageId_key" ON "OrderPinnedSketch"("orderId", "messageId");

-- AddForeignKey
ALTER TABLE "OrderPinnedSketch" ADD CONSTRAINT "OrderPinnedSketch_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderPinnedSketch" ADD CONSTRAINT "OrderPinnedSketch_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "Message"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Copy existing single final sketches before dropping the column.
INSERT INTO "OrderPinnedSketch" ("orderId", "messageId", "createdAt", "updatedAt")
SELECT id, "finalSketchMessageId", CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "Order"
WHERE "finalSketchMessageId" IS NOT NULL;

-- DropForeignKey
ALTER TABLE "Order" DROP CONSTRAINT "Order_finalSketchMessageId_fkey";

-- DropIndex
DROP INDEX "Order_finalSketchMessageId_key";

-- AlterTable
ALTER TABLE "Order" DROP COLUMN "finalSketchMessageId";
