-- AlterTable
ALTER TABLE "BluesalesTag" ADD COLUMN     "color" TEXT;

-- CreateTable
CREATE TABLE "_BluesalesTagToLead" (
    "A" TEXT NOT NULL,
    "B" INTEGER NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "_BluesalesTagToLead_AB_unique" ON "_BluesalesTagToLead"("A", "B");

-- CreateIndex
CREATE INDEX "_BluesalesTagToLead_B_index" ON "_BluesalesTagToLead"("B");

-- CreateIndex
CREATE INDEX "BluesalesTag_name_idx" ON "BluesalesTag"("name");

-- AddForeignKey
ALTER TABLE "_BluesalesTagToLead" ADD CONSTRAINT "_BluesalesTagToLead_A_fkey" FOREIGN KEY ("A") REFERENCES "BluesalesTag"("bsTagId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_BluesalesTagToLead" ADD CONSTRAINT "_BluesalesTagToLead_B_fkey" FOREIGN KEY ("B") REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;
