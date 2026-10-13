export const IMAGE_QUEUE_SAMPLE_MS = 20_000;
export const IMAGE_QUEUE_RETENTION_HOURS = 168;
export const IMAGE_QUEUE_HOUR_MS = 3_600_000;

export interface ImageQueueMeasurement {
  kind: 'preview' | 'production';
  durationMs: number;
  completedAt: number;
  success: boolean;
}

export interface QueueState { waiting: number; running: number }

/** Database rows already include operations admitted to the in-process queue. */
export function imageQueueBacklog(
  previewPending: number,
  productionPending: number,
  productionProcessing: number,
  local: { preview: QueueState; production: QueueState },
) {
  const previewRunning = local.preview.running;
  // Production callbacks claim a database row only after admission to a shared
  // worker slot. Queued callbacks therefore still belong to database pending.
  const productionRunning = Math.min(productionProcessing, local.production.running);
  return {
    preview: {
      waiting: Math.max(0, Math.max(previewPending, local.preview.waiting + previewRunning) - previewRunning),
      running: previewRunning,
    },
    production: {
      waiting: productionPending + productionProcessing - productionRunning,
      running: productionRunning,
    },
  };
}

export function completionSummary(measurements: ImageQueueMeasurement[], kind: ImageQueueMeasurement['kind']) {
  const successful = measurements.filter((row) => row.kind === kind && row.success);
  return {
    completed: successful.length,
    durationMs: Math.min(2_147_483_647, Math.round(successful.reduce((sum, row) => sum + Math.max(1, row.durationMs), 0))),
    lastCompletedAt: successful.length ? new Date(Math.max(...successful.map((row) => row.completedAt))) : null,
  };
}

export function imageQueueEstimate(input: {
  outstanding: number; completed: number; durationMs: number; concurrency: number;
  observedMs: number; hasRecentLocalSuccess: boolean;
}) {
  const averageDurationMs = input.completed ? Math.round(input.durationMs / input.completed) : null;
  // A few completions and an active local worker are required. Old history alone
  // must not promise progress when the restarted worker or storage is stalled.
  const throughputPerMinute = input.completed >= 3 && averageDurationMs && input.hasRecentLocalSuccess
    ? Math.min(input.concurrency * 60_000 / averageDurationMs, input.completed * 60_000 / Math.max(20_000, input.observedMs))
    : null;
  return {
    completedLastHour: input.completed,
    averageDurationMs,
    throughputPerMinute,
    etaSeconds: input.outstanding === 0 ? 0 : throughputPerMinute ? Math.ceil(input.outstanding * 60 / throughputPerMinute) : null,
  };
}
