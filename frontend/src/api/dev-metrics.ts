export interface InboundSyncState {
  enabled: boolean
  updatedAt: string
}

export interface ProductionTaskCounts {
  newTasks: number
  changedTasks: number
  retriedTasks: number
  sizes: Record<'30x40' | '40x60' | '60x80', number>
}

export interface ProductionChange {
  field: string
  before: string | number | string[] | null
  after: string | number | string[] | null
}

export interface ProductionTaskEvent {
  at: string
  textSize: string
  reason: string
  cause: string | null
  trigger: string | null
  changes: ProductionChange[] | null
}

export interface ProductionQueueTask {
  id: number
  orderId: number
  orderNumber: string
  attachmentId: number
  textSize: string
  status: string
  attempts: number
  error: string | null
  createdAt: string
  queuedAt: string | null
  nextAttemptAt: string
  leaseUntil: string | null
  leaseExpired: boolean
  cause: string
  category: string
  trigger: string | null
  changes: ProductionChange[] | null
}

export interface ProductionDebugMetrics {
  generatedAt: string
  period: { from: string; to: string }
  retentionDays: number
  totals: { newTasks: number; newPhotos: number; changedTasks: number; retriedTasks: number }
  rows: (ProductionTaskCounts & {
    orderId: number
    orderNumber: string
    lastCreatedAt: string
    newPhotos: number
    completePhotoSets: number
    photos: (ProductionTaskCounts & { attachmentId: number; lastCreatedAt: string; events: ProductionTaskEvent[] })[]
  })[]
  queue: {
    total: number; pending: number; processing: number; photos: number; orders: number
    causes: { cause: string; count: number }[]
    rows: ProductionQueueTask[]
  }
}

export interface DevMetrics {
  generatedAt: string
  timeZone: string
  period: { date: string; start: string; end: string; isCurrent: boolean }
  trackingSince: string | null
  summary: { totalMs: number; count: number; averageMs: number; targetMs: number; remainingMs: number }
  labels: { label: string; durationMs: number; count: number; averageMs: number; maxMs: number }[]
  hourly: { at: string; durationMs: number; count: number; cumulativeMs: number }[]
  forecast: {
    status: 'closed' | 'reached' | 'insufficient-data' | 'will-reach' | 'below-target'
    projectedTotalMs: number | null
    reachesAt: string | null
    windowStart: string
    windowEnd: string
    sampleCount: number
    points: { at: string; totalMs: number }[]
  }
  history: { date: string; durationMs: number; count: number }[]
}

export interface ImageQueueState {
  waiting: number
  running: number
  ready: number
  failed: number
  unavailable: number
  completedLastHour: number
  averageDurationMs: number | null
  throughputPerMinute: number | null
  etaSeconds: number | null
}

export interface ImageQueueMetrics {
  sampledAt: string
  historyHours: number
  samplingIntervalSeconds: number
  retentionHours: number
  concurrency: { total: number; preview: number; production: number; scope: 'process' }
  preview: ImageQueueState
  production: ImageQueueState
  etaSeconds: number | null
  estimateAssumption: 'no_new_jobs'
  measurementScope: 'process'
  history: {
    sampledAt: string
    previewWaiting: number
    previewRunning: number
    productionWaiting: number
    productionRunning: number
    previewCompleted: number
    productionCompleted: number
  }[]
}
