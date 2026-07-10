/*
  Warnings:

  - You are about to drop the column `answerToId` on the `Message` table. All the data in the column will be lost.
  - You are about to drop the column `kind` on the `Message` table. All the data in the column will be lost.

*/
-- DropForeignKey
ALTER TABLE "Message" DROP CONSTRAINT "Message_answerToId_fkey";

-- DropIndex
DROP INDEX "Message_answerToId_idx";

-- DropIndex
DROP INDEX "Message_orderId_kind_idx";

-- AlterTable
ALTER TABLE "Message" DROP COLUMN "answerToId",
DROP COLUMN "kind";

-- DropEnum
DROP TYPE "MessageKind";

-- CreateTable
CREATE TABLE "Revision" (
    "id" SERIAL NOT NULL,
    "orderId" INTEGER NOT NULL,
    "messageId" INTEGER NOT NULL,
    "openedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Revision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RevisionClosure" (
    "id" SERIAL NOT NULL,
    "revisionId" INTEGER NOT NULL,
    "messageId" INTEGER,
    "closedById" INTEGER NOT NULL,
    "openedAt" TIMESTAMP(3) NOT NULL,
    "closedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RevisionClosure_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Revision_messageId_key" ON "Revision"("messageId");

-- CreateIndex
CREATE INDEX "Revision_orderId_idx" ON "Revision"("orderId");

-- CreateIndex
CREATE UNIQUE INDEX "RevisionClosure_revisionId_key" ON "RevisionClosure"("revisionId");

-- CreateIndex
CREATE UNIQUE INDEX "RevisionClosure_messageId_key" ON "RevisionClosure"("messageId");

-- CreateIndex
CREATE INDEX "RevisionClosure_closedById_idx" ON "RevisionClosure"("closedById");

-- CreateIndex
CREATE INDEX "RevisionClosure_closedAt_idx" ON "RevisionClosure"("closedAt");

-- AddForeignKey
ALTER TABLE "Revision" ADD CONSTRAINT "Revision_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Revision" ADD CONSTRAINT "Revision_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "Message"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RevisionClosure" ADD CONSTRAINT "RevisionClosure_revisionId_fkey" FOREIGN KEY ("revisionId") REFERENCES "Revision"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RevisionClosure" ADD CONSTRAINT "RevisionClosure_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "Message"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RevisionClosure" ADD CONSTRAINT "RevisionClosure_closedById_fkey" FOREIGN KEY ("closedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
