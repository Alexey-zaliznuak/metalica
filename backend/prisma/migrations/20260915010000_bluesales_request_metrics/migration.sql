CREATE TABLE "BluesalesRequestMetric" (
    "id" BIGSERIAL NOT NULL,
    "label" VARCHAR(120) NOT NULL,
    "method" VARCHAR(120) NOT NULL,
    "startedAt" TIMESTAMPTZ(3) NOT NULL,
    "completedAt" TIMESTAMPTZ(3) NOT NULL,
    "durationMs" INTEGER NOT NULL,
    "periodStart" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "BluesalesRequestMetric_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "BluesalesRequestMetric_periodStart_label_idx" ON "BluesalesRequestMetric"("periodStart", "label");
CREATE INDEX "BluesalesRequestMetric_startedAt_idx" ON "BluesalesRequestMetric"("startedAt");
