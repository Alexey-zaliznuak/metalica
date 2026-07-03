-- AlterTable
ALTER TABLE "Lead" ADD COLUMN     "lastContactAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "Lead_lastContactAt_idx" ON "Lead"("lastContactAt");
