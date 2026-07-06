-- AlterTable
ALTER TABLE "Lead" ADD COLUMN     "managerId" INTEGER,
ADD COLUMN     "managerName" TEXT;

-- CreateIndex
CREATE INDEX "Lead_managerId_idx" ON "Lead"("managerId");
