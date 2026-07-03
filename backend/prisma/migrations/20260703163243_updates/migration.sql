-- AlterTable
ALTER TABLE "Lead" ADD COLUMN     "salesChannel" TEXT;

-- CreateTable
CREATE TABLE "BluesalesSource" (
    "bsSourceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BluesalesSource_pkey" PRIMARY KEY ("bsSourceId")
);

-- CreateTable
CREATE TABLE "BluesalesSalesChannel" (
    "bsSalesChannelId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BluesalesSalesChannel_pkey" PRIMARY KEY ("bsSalesChannelId")
);
