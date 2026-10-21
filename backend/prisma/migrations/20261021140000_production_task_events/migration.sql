CREATE TABLE "ProductionTaskEvent" (
    "id" BIGSERIAL NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "orderId" INTEGER NOT NULL,
    "orderNumber" TEXT NOT NULL,
    "attachmentId" INTEGER NOT NULL,
    "textSize" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    CONSTRAINT "ProductionTaskEvent_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "ProductionTaskEvent_createdAt_idx" ON "ProductionTaskEvent"("createdAt");
