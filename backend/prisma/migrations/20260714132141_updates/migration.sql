-- CreateTable
CREATE TABLE "BluesalesOrderStatus" (
    "bsOrderStatusId" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BluesalesOrderStatus_pkey" PRIMARY KEY ("bsOrderStatusId")
);
