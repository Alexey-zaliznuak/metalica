-- CreateEnum
CREATE TYPE "Role" AS ENUM ('MANAGER', 'DESIGNER', 'ADMIN');

-- CreateEnum
CREATE TYPE "OrderStatus" AS ENUM ('NEW', 'IN_PROGRESS', 'IN_REVISION', 'DONE');

-- CreateEnum
CREATE TYPE "OrderSource" AS ENUM ('MANUAL', 'BLUESALES');

-- CreateEnum
CREATE TYPE "MessageKind" AS ENUM ('NORMAL', 'REVISION_REQUEST', 'REVISION_ANSWER');

-- CreateTable
CREATE TABLE "User" (
    "id" SERIAL NOT NULL,
    "username" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "role" "Role" NOT NULL DEFAULT 'MANAGER',
    "passwordHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Order" (
    "id" SERIAL NOT NULL,
    "orderNumber" TEXT NOT NULL,
    "title" TEXT,
    "status" "OrderStatus" NOT NULL DEFAULT 'NEW',
    "source" "OrderSource" NOT NULL DEFAULT 'MANUAL',
    "leadId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Order_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BluesalesOrderInfo" (
    "id" SERIAL NOT NULL,
    "orderId" INTEGER NOT NULL,
    "bsOrderId" INTEGER NOT NULL,
    "bsNumber" TEXT,
    "orderStatusId" INTEGER,
    "orderStatus" TEXT,
    "crmStatusId" INTEGER,
    "crmStatus" TEXT,
    "totalSum" DOUBLE PRECISION,
    "bsCreatedAt" TIMESTAMP(3),
    "rawPayload" JSONB,
    "lastSyncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BluesalesOrderInfo_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Lead" (
    "id" SERIAL NOT NULL,
    "bsCustomerId" INTEGER,
    "name" TEXT,
    "fullName" TEXT,
    "vkDialogUrl" TEXT,
    "vkUserId" TEXT,
    "crmStatus" TEXT,
    "lastSyncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Lead_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SyncState" (
    "id" SERIAL NOT NULL,
    "key" TEXT NOT NULL,
    "lastRunAt" TIMESTAMP(3),
    "lastSuccessAt" TIMESTAMP(3),
    "lastError" TEXT,
    "cursor" TEXT,
    "itemsSynced" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SyncState_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Message" (
    "id" SERIAL NOT NULL,
    "orderId" INTEGER NOT NULL,
    "authorId" INTEGER NOT NULL,
    "kind" "MessageKind" NOT NULL DEFAULT 'NORMAL',
    "body" TEXT,
    "answerToId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Message_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Attachment" (
    "id" SERIAL NOT NULL,
    "messageId" INTEGER NOT NULL,
    "objectKey" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "mimeType" TEXT,
    "kind" TEXT NOT NULL DEFAULT 'attachment',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Attachment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_username_key" ON "User"("username");

-- CreateIndex
CREATE INDEX "User_role_idx" ON "User"("role");

-- CreateIndex
CREATE UNIQUE INDEX "Order_orderNumber_key" ON "Order"("orderNumber");

-- CreateIndex
CREATE INDEX "Order_status_idx" ON "Order"("status");

-- CreateIndex
CREATE INDEX "Order_source_idx" ON "Order"("source");

-- CreateIndex
CREATE INDEX "Order_leadId_idx" ON "Order"("leadId");

-- CreateIndex
CREATE UNIQUE INDEX "BluesalesOrderInfo_orderId_key" ON "BluesalesOrderInfo"("orderId");

-- CreateIndex
CREATE UNIQUE INDEX "BluesalesOrderInfo_bsOrderId_key" ON "BluesalesOrderInfo"("bsOrderId");

-- CreateIndex
CREATE INDEX "BluesalesOrderInfo_orderStatusId_idx" ON "BluesalesOrderInfo"("orderStatusId");

-- CreateIndex
CREATE INDEX "BluesalesOrderInfo_crmStatusId_idx" ON "BluesalesOrderInfo"("crmStatusId");

-- CreateIndex
CREATE INDEX "BluesalesOrderInfo_bsCreatedAt_idx" ON "BluesalesOrderInfo"("bsCreatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "Lead_bsCustomerId_key" ON "Lead"("bsCustomerId");

-- CreateIndex
CREATE INDEX "Lead_crmStatus_idx" ON "Lead"("crmStatus");

-- CreateIndex
CREATE UNIQUE INDEX "SyncState_key_key" ON "SyncState"("key");

-- CreateIndex
CREATE INDEX "Message_orderId_createdAt_idx" ON "Message"("orderId", "createdAt");

-- CreateIndex
CREATE INDEX "Message_orderId_kind_idx" ON "Message"("orderId", "kind");

-- CreateIndex
CREATE INDEX "Message_answerToId_idx" ON "Message"("answerToId");

-- CreateIndex
CREATE INDEX "Attachment_messageId_idx" ON "Attachment"("messageId");

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BluesalesOrderInfo" ADD CONSTRAINT "BluesalesOrderInfo_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_answerToId_fkey" FOREIGN KEY ("answerToId") REFERENCES "Message"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Attachment" ADD CONSTRAINT "Attachment_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "Message"("id") ON DELETE CASCADE ON UPDATE CASCADE;
