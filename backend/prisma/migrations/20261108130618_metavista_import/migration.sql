-- CreateTable
CREATE TABLE "MetavistaSyncState" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "cursor" INTEGER NOT NULL DEFAULT 0,
    "initialized" BOOLEAN NOT NULL DEFAULT false,
    "lockToken" TEXT,
    "lockedUntil" TIMESTAMP(3),
    "lastPollAt" TIMESTAMP(3),
    "lastError" TEXT,

    CONSTRAINT "MetavistaSyncState_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MetavistaOrder" (
    "externalId" TEXT NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT -1,
    "orderId" INTEGER,
    "snapshot" JSONB,
    "deletedAt" TIMESTAMP(3),
    "paymentStatus" TEXT,
    "totalEur" DECIMAL(14,2),
    "exchangeRate" DECIMAL(14,6),
    "rateSource" TEXT,
    "bsCustomerId" INTEGER,
    "bsOrderId" INTEGER,
    "customerAttemptAt" TIMESTAMP(3),
    "orderAttemptAt" TIMESTAMP(3),
    "exportState" TEXT NOT NULL DEFAULT 'WAITING_PAYMENT',
    "lastError" TEXT,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MetavistaOrder_pkey" PRIMARY KEY ("externalId")
);

-- CreateTable
CREATE TABLE "MetavistaFile" (
    "id" SERIAL NOT NULL,
    "externalId" TEXT NOT NULL,
    "itemId" INTEGER NOT NULL,
    "fileId" TEXT NOT NULL,
    "slot" TEXT NOT NULL,
    "objectKey" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "attachmentId" INTEGER,

    CONSTRAINT "MetavistaFile_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "MetavistaOrder_orderId_key" ON "MetavistaOrder"("orderId");

-- CreateIndex
CREATE UNIQUE INDEX "MetavistaOrder_bsOrderId_key" ON "MetavistaOrder"("bsOrderId");

-- CreateIndex
CREATE INDEX "MetavistaOrder_exportState_nextAttemptAt_idx" ON "MetavistaOrder"("exportState", "nextAttemptAt");

-- CreateIndex
CREATE UNIQUE INDEX "MetavistaFile_externalId_itemId_fileId_slot_key" ON "MetavistaFile"("externalId", "itemId", "fileId", "slot");

-- AddForeignKey
ALTER TABLE "MetavistaOrder" ADD CONSTRAINT "MetavistaOrder_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MetavistaFile" ADD CONSTRAINT "MetavistaFile_externalId_fkey" FOREIGN KEY ("externalId") REFERENCES "MetavistaOrder"("externalId") ON DELETE CASCADE ON UPDATE CASCADE;
