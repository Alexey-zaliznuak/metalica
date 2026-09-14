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
