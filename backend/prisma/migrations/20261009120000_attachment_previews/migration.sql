ALTER TABLE "Attachment"
  ADD COLUMN "thumbnailKey" TEXT,
  ADD COLUMN "previewKey" TEXT,
  ADD COLUMN "previewStatus" TEXT NOT NULL DEFAULT 'pending',
  ADD COLUMN "previewAttempts" INTEGER NOT NULL DEFAULT 0;

CREATE INDEX "Attachment_previewStatus_id_idx" ON "Attachment"("previewStatus", "id");
