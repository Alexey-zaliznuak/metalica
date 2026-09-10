-- DropIndex
DROP INDEX "Attachment_printPhotoOrderId_key";

-- CreateIndex
CREATE INDEX "Attachment_printPhotoOrderId_idx" ON "Attachment"("printPhotoOrderId");
