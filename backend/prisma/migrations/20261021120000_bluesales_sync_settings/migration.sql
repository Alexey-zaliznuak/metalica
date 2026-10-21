CREATE TABLE "BluesalesSyncSettings" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "inboundEnabled" BOOLEAN NOT NULL DEFAULT true,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BluesalesSyncSettings_pkey" PRIMARY KEY ("id")
);
