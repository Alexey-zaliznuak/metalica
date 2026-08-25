-- CreateEnum
CREATE TYPE "OrderDirection" AS ENUM ('PHOTO_RETOUCH', 'NEURO_ART', 'DIGITAL');

-- AlterEnum
ALTER TYPE "Role" ADD VALUE 'PRODUCTION';

-- AlterTable
ALTER TABLE "BluesalesOrderStatus" ADD COLUMN     "assignRevisionDesigner" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "assignSketchDesigner" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "directions" "OrderDirection"[] DEFAULT ARRAY[]::"OrderDirection"[],
ADD COLUMN     "onShift" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "onShiftAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "BluesalesGoods" (
    "bsGoodsId" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "marking" TEXT,
    "direction" "OrderDirection",
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BluesalesGoods_pkey" PRIMARY KEY ("bsGoodsId")
);

-- CreateTable
CREATE TABLE "AssignmentCursor" (
    "id" SERIAL NOT NULL,
    "direction" "OrderDirection" NOT NULL,
    "designerRole" "Role" NOT NULL,
    "lastUserId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AssignmentCursor_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BluesalesGoods_direction_idx" ON "BluesalesGoods"("direction");

-- CreateIndex
CREATE INDEX "BluesalesGoods_name_idx" ON "BluesalesGoods"("name");

-- CreateIndex
CREATE UNIQUE INDEX "AssignmentCursor_direction_designerRole_key" ON "AssignmentCursor"("direction", "designerRole");

-- CreateIndex
CREATE INDEX "User_role_onShift_idx" ON "User"("role", "onShift");
