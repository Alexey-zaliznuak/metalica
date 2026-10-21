export interface InboundSyncState {
  enabled: boolean
  updatedAt: string
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
