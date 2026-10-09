CREATE TABLE "ProductionFile" (
  "id" SERIAL NOT NULL,
  "orderId" INTEGER NOT NULL,
  "attachmentId" INTEGER NOT NULL,
  "textSize" TEXT NOT NULL,
  "fingerprint" TEXT NOT NULL,
  "sourceKey" TEXT NOT NULL,
  "parameters" JSONB NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "objectKey" TEXT,
  "size" INTEGER,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "runToken" TEXT,
  "leaseUntil" TIMESTAMP(3),
  "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "error" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ProductionFile_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ProductionFile_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "ProductionFile_attachmentId_fkey" FOREIGN KEY ("attachmentId") REFERENCES "Attachment"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "ProductionFile_orderId_attachmentId_textSize_key" ON "ProductionFile"("orderId", "attachmentId", "textSize");
CREATE INDEX "ProductionFile_status_nextAttemptAt_idx" ON "ProductionFile"("status", "nextAttemptAt");

CREATE TABLE "StoredFileDeletion" (
  "objectKey" TEXT NOT NULL,
  "generation" INTEGER NOT NULL DEFAULT 0,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "StoredFileDeletion_pkey" PRIMARY KEY ("objectKey")
);
CREATE INDEX "StoredFileDeletion_nextAttemptAt_idx" ON "StoredFileDeletion"("nextAttemptAt");
