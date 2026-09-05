/*
  Warnings:

  - A unique constraint covering the columns `[printPhotoOrderId]` on the table `Attachment` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[finalSketchMessageId]` on the table `Order` will be added. If there are existing duplicate values, this will fail.

*/
-- AlterTable
ALTER TABLE "Attachment" ADD COLUMN     "printPhotoOrderId" INTEGER;

-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "finalSketchMessageId" INTEGER;

-- CreateIndex
CREATE UNIQUE INDEX "Attachment_printPhotoOrderId_key" ON "Attachment"("printPhotoOrderId");

-- CreateIndex
CREATE UNIQUE INDEX "Order_finalSketchMessageId_key" ON "Order"("finalSketchMessageId");

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_finalSketchMessageId_fkey" FOREIGN KEY ("finalSketchMessageId") REFERENCES "Message"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Attachment" ADD CONSTRAINT "Attachment_printPhotoOrderId_fkey" FOREIGN KEY ("printPhotoOrderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;
