CREATE TABLE "OrderSystemTag" (
  "id" SERIAL NOT NULL,
  "orderId" INTEGER NOT NULL,
  "kind" TEXT NOT NULL,
  "markedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completedAt" TIMESTAMP(3),
  CONSTRAINT "OrderSystemTag_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "OrderSystemTag_orderId_kind_key" ON "OrderSystemTag"("orderId", "kind");
CREATE INDEX "OrderSystemTag_kind_markedAt_idx" ON "OrderSystemTag"("kind", "markedAt");
ALTER TABLE "OrderSystemTag" ADD CONSTRAINT "OrderSystemTag_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;
