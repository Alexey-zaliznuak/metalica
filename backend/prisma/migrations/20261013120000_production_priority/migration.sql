ALTER TABLE "ProductionFile" ADD COLUMN "priority" INTEGER NOT NULL DEFAULT 0;
CREATE INDEX "ProductionFile_priority_createdAt_idx" ON "ProductionFile"("priority", "createdAt");
