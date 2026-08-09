import { Stack, TextField, ToggleButton, ToggleButtonGroup, Typography } from '@mui/material'

export type AnalyticsPeriodPreset = 'day' | 'week' | 'month' | 'custom'

export interface AnalyticsPeriodValue {
  preset: AnalyticsPeriodPreset
  customFrom: string
  customTo: string
}

const PRESETS: AnalyticsPeriodPreset[] = ['day', 'week', 'month', 'custom']
const LABELS: Record<AnalyticsPeriodPreset, string> = {
  day: 'Последний день',
  week: 'Неделя',
  month: 'Месяц',
  custom: 'Другая дата',
}
const DAY_MS = 24 * 60 * 60 * 1000
const MOSCOW_OFFSET_MS = 3 * 60 * 60 * 1000

function moscowDateKey(date = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Europe/Moscow',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date)
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? ''
  return `${get('year')}-${get('month')}-${get('day')}`
}

function moscowMidnightUtc(dateKey: string, addDays = 0): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateKey)
  if (!match) return null
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const utc = Date.UTC(year, month - 1, day) - MOSCOW_OFFSET_MS
  const check = new Date(utc + MOSCOW_OFFSET_MS)
  if (
    check.getUTCFullYear() !== year ||
    check.getUTCMonth() !== month - 1 ||
    check.getUTCDate() !== day
  ) {
    return null
  }
  return new Date(utc + addDays * DAY_MS)
}

export function createDefaultAnalyticsPeriod(): AnalyticsPeriodValue {
  const today = moscowDateKey()
  return { preset: 'day', customFrom: today, customTo: today }
}

export function resolveAnalyticsDateRange(value: AnalyticsPeriodValue) {
  if (value.preset === 'custom') {
    const from = moscowMidnightUtc(value.customFrom)
    const to = moscowMidnightUtc(value.customTo, 1)
    if (!from || !to || from >= to) return null
    return { dateFrom: from.toISOString(), dateTo: to.toISOString() }
  }

  const now = new Date()
  const days = value.preset === 'day' ? 1 : value.preset === 'week' ? 7 : 30
  return {
    dateFrom: new Date(now.getTime() - days * DAY_MS).toISOString(),
    dateTo: now.toISOString(),
  }
}

export default function AnalyticsDateFilter({
  value,
  onChange,
}: {
  value: AnalyticsPeriodValue
  onChange: (value: AnalyticsPeriodValue) => void
}) {
  return (
    <Stack spacing={1.5}>
      <Typography variant="body2" sx={{ fontWeight: 600 }}>
        Период:
      </Typography>
      <ToggleButtonGroup
        value={value.preset}
        exclusive
        size="small"
        onChange={(_, preset: AnalyticsPeriodPreset | null) => {
          if (preset) onChange({ ...value, preset })
        }}
        sx={{ flexWrap: 'wrap', alignSelf: 'flex-start' }}
      >
        {PRESETS.map((preset) => (
          <ToggleButton key={preset} value={preset}>
            {LABELS[preset]}
          </ToggleButton>
        ))}
      </ToggleButtonGroup>
      {value.preset === 'custom' && (
        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5}>
          <TextField
            type="date"
            label="С"
            value={value.customFrom}
            onChange={(event) => onChange({ ...value, customFrom: event.target.value })}
            size="small"
            InputLabelProps={{ shrink: true }}
          />
          <TextField
            type="date"
            label="По"
            value={value.customTo}
            onChange={(event) => onChange({ ...value, customTo: event.target.value })}
            size="small"
            InputLabelProps={{ shrink: true }}
          />
          <Typography variant="caption" color="text.secondary" sx={{ alignSelf: 'center' }}>
            Даты считаются по Москве
          </Typography>
        </Stack>
      )}
    </Stack>
  )
}
