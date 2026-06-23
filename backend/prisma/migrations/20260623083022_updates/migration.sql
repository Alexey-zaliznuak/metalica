/*
  Warnings:

  - You are about to drop the column `status` on the `Order` table. All the data in the column will be lost.

*/
-- DropIndex
DROP INDEX "Order_status_idx";

-- AlterTable
ALTER TABLE "Order" DROP COLUMN "status";

-- DropEnum
DROP TYPE "OrderStatus";
