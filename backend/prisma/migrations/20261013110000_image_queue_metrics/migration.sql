CREATE TABLE "ImageQueueMetric" (
    "id" BIGSERIAL NOT NULL,
    "sampledAt" TIMESTAMPTZ(3) NOT NULL,
    "previewWaiting" INTEGER NOT NULL,
    "previewRunning" INTEGER NOT NULL,
    "productionWaiting" INTEGER NOT NULL,
    "productionRunning" INTEGER NOT NULL,
    "previewCompleted" INTEGER NOT NULL DEFAULT 0,
    "productionCompleted" INTEGER NOT NULL DEFAULT 0,
    "previewDurationMs" INTEGER NOT NULL DEFAULT 0,
    "productionDurationMs" INTEGER NOT NULL DEFAULT 0,
    "previewLastCompletedAt" TIMESTAMPTZ(3),
    "productionLastCompletedAt" TIMESTAMPTZ(3),
    CONSTRAINT "ImageQueueMetric_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "ImageQueueMetric_sampledAt_idx" ON "ImageQueueMetric"("sampledAt");
