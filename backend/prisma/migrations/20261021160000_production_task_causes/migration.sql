ALTER TABLE "ProductionFile"
  ADD COLUMN "queuedAt" TIMESTAMPTZ(3),
  ADD COLUMN "queueReason" TEXT,
  ADD COLUMN "queueSource" TEXT,
  ADD COLUMN "queueChanges" JSONB;
ALTER TABLE "ProductionTaskEvent"
  ADD COLUMN "cause" TEXT,
  ADD COLUMN "trigger" TEXT,
  ADD COLUMN "changes" JSONB;
CREATE INDEX "ProductionTaskEvent_identity_createdAt_idx"
  ON "ProductionTaskEvent"("orderId", "attachmentId", "textSize", "createdAt" DESC, "id" DESC);
