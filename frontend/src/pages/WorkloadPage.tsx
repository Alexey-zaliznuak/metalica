import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Alert,
  Autocomplete,
  Box,
  Button,
  Checkbox,
  CircularProgress,
  Divider,
  FormControlLabel,
  Paper,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  TableSortLabel,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Typography,
} from '@mui/material'
import client from '../api/client'
import { describeApiError, logApiError } from '../api/errors'
import { useAuth } from '../auth/AuthContext'
import type { BluesalesStatusOption, WorkloadMetric } from '../api/types'

type WorkloadTab = 'sketch' | 'revision' | 'delivery' | 'onboarding'
type SortDirection = 'asc' | 'desc'
type WorkloadPeriodPreset = 'day' | 'week' | 'month' | 'custom'
type WorkloadMetricKey =
  | 'sketchOrders'
  | 'revisionOrders'
  | 'deliveryOrders'
  | 'onboardingOrders'

const WORKLOAD_TABS: WorkloadTab[] = ['sketch', 'revision', 'delivery', 'onboarding']
const WORKLOAD_PERIOD_PRESETS: WorkloadPeriodPreset[] = ['day', 'week', 'month', 'custom']
const PERIOD_LABELS: Record<WorkloadPeriodPreset, string> = {
  day: 'Последний день',
  week: 'Неделя',
  month: 'Месяц',
  custom: 'Другая дата',
}
const MOSCOW_OFFSET_MS = 3 * 60 * 60 * 1000
const DAY_MS = 24 * 60 * 60 * 1000

const TAB_CONFIG: Record<
  WorkloadTab,
  {
    label: string
    role: 'SKETCH_DESIGNER' | 'REVISION_DESIGNER' | 'MANAGER'
    metric: WorkloadMetricKey
    columnLabel: string
  }
> = {
  sketch: {
    label: 'Художники · Эскизы',
    role: 'SKETCH_DESIGNER',
    metric: 'sketchOrders',
    columnLabel: 'Эскизы',
  },
  revision: {
    label: 'Художники · Правки',
    role: 'REVISION_DESIGNER',
    metric: 'revisionOrders',
    columnLabel: 'Правки',
  },
  delivery: {
    label: 'Менеджеры · Ведение',
    role: 'MANAGER',
    metric: 'deliveryOrders',
    columnLabel: 'Ведение',
  },
  onboarding: {
    label: 'Менеджеры · Оформление',
    role: 'MANAGER',
    metric: 'onboardingOrders',
    columnLabel: 'Оформление',
  },
}

type StatusSelections = Record<WorkloadTab, number[]>
type ParsedStatusSelections = Record<WorkloadTab, number[] | null>

const DEFAULT_STATUS_SELECTIONS: StatusSelections = {
  sketch: [],
  revision: [],
  delivery: [],
  onboarding: [],
}

interface WorkloadTabSettings {
  selectedOrderStatusIds: number[]
}

type WorkloadPageSettings = Record<WorkloadTab, WorkloadTabSettings> & {
  onlyOpenSketch: boolean
  period: {
    preset: WorkloadPeriodPreset
    customFrom: string
    customTo: string
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseStatusIds(raw: unknown): number[] | null {
  if (!Array.isArray(raw)) return null
  return raw
    .map((value) => Number(value))
    .filter((value, index, arr) => Number.isInteger(value) && value >= 0 && arr.indexOf(value) === index)
}

function parseWorkloadSettings(raw: unknown): ParsedStatusSelections {
  const result: ParsedStatusSelections = {
    sketch: null,
    revision: null,
    delivery: null,
    onboarding: null,
  }
  if (!isRecord(raw)) return result
  for (const tab of WORKLOAD_TABS) {
    const tabRaw = raw[tab]
    if (isRecord(tabRaw)) {
      result[tab] = parseStatusIds(tabRaw.selectedOrderStatusIds)
    }
  }
  return result
}

function normalizeStatusSelection(availableStatusIds: number[], selectedRaw: number[] | null) {
  if (selectedRaw === null) return availableStatusIds
  const available = new Set(availableStatusIds)
  const normalized = selectedRaw.filter(
    (id, index, arr) => available.has(id) && arr.indexOf(id) === index,
  )
  return normalized
}

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

function resolveDateRange(
  preset: WorkloadPeriodPreset,
  customFrom: string,
  customTo: string,
): { dateFrom: string; dateTo: string } | null {
  if (preset === 'custom') {
    const from = moscowMidnightUtc(customFrom)
    const to = moscowMidnightUtc(customTo, 1)
    if (!from || !to || from >= to) return null
    return { dateFrom: from.toISOString(), dateTo: to.toISOString() }
  }

  const now = new Date()
  const days = preset === 'day' ? 1 : preset === 'week' ? 7 : 30
  return {
    dateFrom: new Date(now.getTime() - days * DAY_MS).toISOString(),
    dateTo: now.toISOString(),
  }
}

function parsePeriodSettings(raw: unknown) {
  const today = moscowDateKey()
  if (!isRecord(raw)) {
    return { preset: 'day' as WorkloadPeriodPreset, customFrom: today, customTo: today }
  }
  const preset = WORKLOAD_PERIOD_PRESETS.includes(raw.preset as WorkloadPeriodPreset)
    ? (raw.preset as WorkloadPeriodPreset)
    : 'day'
  const customFrom = typeof raw.customFrom === 'string' ? raw.customFrom : today
  const customTo = typeof raw.customTo === 'string' ? raw.customTo : today
  return { preset, customFrom, customTo }
}

export default function WorkloadPage() {
  const { user, updateFrontendSettings } = useAuth()
  const [loading, setLoading] = useState(true)
  const [statusesLoading, setStatusesLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [tab, setTab] = useState<WorkloadTab>('sketch')
  const [items, setItems] = useState<WorkloadMetric[]>([])
  const [orderStatuses, setOrderStatuses] = useState<BluesalesStatusOption[]>([])
  const [statusesLoaded, setStatusesLoaded] = useState(false)
  const [statusSelections, setStatusSelections] = useState<StatusSelections>(
    DEFAULT_STATUS_SELECTIONS,
  )
  const [statusFilterOpen, setStatusFilterOpen] = useState(false)
  const [sortDirection, setSortDirection] = useState<SortDirection>('desc')
  const [onlyOpenSketch, setOnlyOpenSketch] = useState(false)
  const [periodPreset, setPeriodPreset] = useState<WorkloadPeriodPreset>('day')
  const [customFrom, setCustomFrom] = useState(() => moscowDateKey())
  const [customTo, setCustomTo] = useState(() => moscowDateKey())
  const [initialized, setInitialized] = useState(false)

  // See OrdersPage for the rationale: once the user edits locally we stop
  // overwriting their selection with backend/other-device settings until
  // remount; skipSaveRef prevents echoing applied settings back to the server.
  const dirtyRef = useRef(false)
  const skipSaveRef = useRef(false)

  const activeSelection = statusSelections[tab]

  useEffect(() => {
    let active = true
    ;(async () => {
      setStatusesLoading(true)
      setError(null)
      try {
        const { data } = await client.get<BluesalesStatusOption[]>('/orders/order-statuses')
        if (!active) return
        setOrderStatuses(data)
        setStatusesLoaded(true)
      } catch (err) {
        logApiError('загрузка статусов заказов', err)
        if (!active) return
        setError(describeApiError(err, 'Не удалось загрузить статусы заказов'))
        setStatusesLoaded(true)
      } finally {
        if (active) {
          setStatusesLoading(false)
        }
      }
    })()
    return () => {
      active = false
    }
  }, [])

  useEffect(() => {
    if (!statusesLoaded) return
    if (dirtyRef.current) return

    const settings = user?.frontendSettings
    const workloadSettings = isRecord(settings) && isRecord(settings.workloadPage)
      ? settings.workloadPage
      : undefined
    const parsed = parseWorkloadSettings(
      workloadSettings,
    )
    const allStatusIds = orderStatuses.map((status) => status.id)

    const normalized: StatusSelections = {
      sketch: normalizeStatusSelection(allStatusIds, parsed.sketch),
      revision: normalizeStatusSelection(allStatusIds, parsed.revision),
      delivery: normalizeStatusSelection(allStatusIds, parsed.delivery),
      onboarding: normalizeStatusSelection(allStatusIds, parsed.onboarding),
    }

    skipSaveRef.current = true
    setStatusSelections(normalized)
    setOnlyOpenSketch(workloadSettings?.onlyOpenSketch === true)
    const periodSettings = parsePeriodSettings(workloadSettings?.period)
    setPeriodPreset(periodSettings.preset)
    setCustomFrom(periodSettings.customFrom)
    setCustomTo(periodSettings.customTo)
    setInitialized(true)
  }, [statusesLoaded, orderStatuses, user?.frontendSettings])

  const dateRange = useMemo(
    () => resolveDateRange(periodPreset, customFrom, customTo),
    [periodPreset, customFrom, customTo],
  )

  useEffect(() => {
    if (!initialized) return
    const periodApplies = tab === 'sketch' || tab === 'revision'
    if (periodApplies && !dateRange) {
      setLoading(false)
      setError('Укажите корректный диапазон дат')
      return
    }
    let active = true
    ;(async () => {
      setLoading(true)
      setError(null)
      try {
        const { data } = await client.get<WorkloadMetric[]>('/metrics/workload', {
          params: {
            orderStatusIds:
              activeSelection.length > 0 ? activeSelection.join(',') : 'none',
            onlyOpenSketch: tab === 'sketch' && onlyOpenSketch ? true : undefined,
            dateFrom: periodApplies ? dateRange?.dateFrom : undefined,
            dateTo: periodApplies ? dateRange?.dateTo : undefined,
          },
        })
        if (!active) return
        setItems(data)
      } catch (err) {
        logApiError('загрузка нагрузки пользователей', err)
        if (active) {
          setError(describeApiError(err, 'Не удалось загрузить нагрузку пользователей'))
        }
      } finally {
        if (active) {
          setLoading(false)
        }
      }
    })()
    return () => {
      active = false
    }
  }, [initialized, activeSelection, tab, onlyOpenSketch, dateRange])

  useEffect(() => {
    if (!initialized) return
    if (skipSaveRef.current) {
      skipSaveRef.current = false
      return
    }
    dirtyRef.current = true
    updateFrontendSettings({
      workloadPage: {
        sketch: { selectedOrderStatusIds: statusSelections.sketch },
        revision: { selectedOrderStatusIds: statusSelections.revision },
        delivery: { selectedOrderStatusIds: statusSelections.delivery },
        onboarding: { selectedOrderStatusIds: statusSelections.onboarding },
        onlyOpenSketch,
        period: {
          preset: periodPreset,
          customFrom,
          customTo,
        },
      } satisfies WorkloadPageSettings,
    })
  }, [
    initialized,
    statusSelections,
    onlyOpenSketch,
    periodPreset,
    customFrom,
    customTo,
    updateFrontendSettings,
  ])

  const config = TAB_CONFIG[tab]

  const visibleItems = useMemo(() => {
    const filtered = items.filter(
      (item) => item.role === config.role && item[config.metric] > 0,
    )
    const sorted = [...filtered].sort((a, b) => {
      const diff = a[config.metric] - b[config.metric]
      if (diff !== 0) {
        return sortDirection === 'asc' ? diff : -diff
      }
      return a.name.localeCompare(b.name, 'ru')
    })
    return sorted
  }, [items, config, sortDirection])

  const selectedStatuses = useMemo(
    () => orderStatuses.filter((status) => activeSelection.includes(status.id)),
    [orderStatuses, activeSelection],
  )

  const toggleSortDirection = () => {
    setSortDirection((current) => (current === 'asc' ? 'desc' : 'asc'))
  }

  const showInitialLoader = statusesLoading || (loading && !initialized)

  if (showInitialLoader) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', py: 8 }}>
        <CircularProgress />
      </Box>
    )
  }

  return (
    <Box>
      <Box sx={{ mb: 3 }}>
        <Typography variant="h4" sx={{ fontWeight: 800 }}>
          Нагрузка
        </Typography>
        <Typography variant="body2" color="text.secondary">
          Завершённые эскизы и правки за период, текущая загрузка менеджеров
        </Typography>
      </Box>

      {error && (
        <Alert severity="error" sx={{ mb: 2 }}>
          {error}
        </Alert>
      )}

      <ToggleButtonGroup
        value={tab}
        exclusive
        onChange={(_, value: WorkloadTab | null) => {
          if (value) setTab(value)
        }}
        size="small"
        sx={{ mb: 2, flexWrap: 'wrap' }}
      >
        {WORKLOAD_TABS.map((tabKey) => (
          <ToggleButton key={tabKey} value={tabKey}>
            {TAB_CONFIG[tabKey].label}
          </ToggleButton>
        ))}
      </ToggleButtonGroup>

      {(tab === 'sketch' || tab === 'revision') && (
        <Stack spacing={1.5} sx={{ mb: 2 }}>
          <ToggleButtonGroup
            value={periodPreset}
            exclusive
            onChange={(_, value: WorkloadPeriodPreset | null) => {
              if (value) setPeriodPreset(value)
            }}
            size="small"
            sx={{ flexWrap: 'wrap', alignSelf: 'flex-start' }}
          >
            {WORKLOAD_PERIOD_PRESETS.map((preset) => (
              <ToggleButton key={preset} value={preset}>
                {PERIOD_LABELS[preset]}
              </ToggleButton>
            ))}
          </ToggleButtonGroup>
          {periodPreset === 'custom' && (
            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5}>
              <TextField
                type="date"
                label="С"
                value={customFrom}
                onChange={(event) => setCustomFrom(event.target.value)}
                size="small"
                InputLabelProps={{ shrink: true }}
              />
              <TextField
                type="date"
                label="По"
                value={customTo}
                onChange={(event) => setCustomTo(event.target.value)}
                size="small"
                InputLabelProps={{ shrink: true }}
              />
              <Typography variant="caption" color="text.secondary" sx={{ alignSelf: 'center' }}>
                Даты считаются по Москве
              </Typography>
            </Stack>
          )}
        </Stack>
      )}

      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2} sx={{ mb: 2 }} alignItems={{ sm: 'center' }}>
        <Autocomplete
          multiple
          disableCloseOnSelect
          open={statusFilterOpen}
          onOpen={() => setStatusFilterOpen(true)}
          onClose={(_, reason) => {
            if (reason === 'selectOption') return
            setStatusFilterOpen(false)
          }}
          options={orderStatuses}
          value={selectedStatuses}
          getOptionLabel={(option) => option.name}
          isOptionEqualToValue={(option, value) => option.id === value.id}
          onChange={(_, values) => {
            const ids = values.map((status) => status.id)
            setStatusSelections((prev) => ({ ...prev, [tab]: ids }))
          }}
          size="small"
          sx={{ minWidth: { xs: '100%', sm: 360 } }}
          renderInput={(params) => <TextField {...params} placeholder="Выбрать статусы" />}
          PaperComponent={({ children, ...paperProps }) => (
            <Paper {...paperProps}>
              <Stack direction="row" spacing={1} sx={{ p: 1 }}>
                <Button
                  size="small"
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() =>
                    setStatusSelections((prev) => ({
                      ...prev,
                      [tab]: orderStatuses.map((status) => status.id),
                    }))
                  }
                >
                  Выбрать все
                </Button>
                <Button
                  size="small"
                  color="inherit"
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() =>
                    setStatusSelections((prev) => ({
                      ...prev,
                      [tab]: [],
                    }))
                  }
                >
                  Убрать все
                </Button>
              </Stack>
              <Divider />
              {children}
            </Paper>
          )}
          renderTags={() => null}
          popupIcon={null}
          noOptionsText="Нет статусов"
          renderOption={(props, option, { selected }) => (
            <li {...props}>
              <Box component="span" sx={{ mr: 1.5, color: 'text.secondary' }}>
                {selected ? '✓' : ''}
              </Box>
              {option.name}
            </li>
          )}
        />
        <Typography variant="body2" color="text.secondary">
          Показано: {visibleItems.length}
        </Typography>
        {tab === 'sketch' && (
          <FormControlLabel
            control={
              <Checkbox
                checked={onlyOpenSketch}
                onChange={(event) => setOnlyOpenSketch(event.target.checked)}
                size="small"
              />
            }
            label="Только с открытым эскизом"
          />
        )}
        {loading && initialized && (
          <Stack direction="row" alignItems="center" spacing={1}>
            <CircularProgress size={16} />
            <Typography variant="caption" color="text.secondary">
              Обновляем данные...
            </Typography>
          </Stack>
        )}
      </Stack>

      <Paper variant="outlined" sx={{ borderRadius: 1.5, overflow: 'hidden' }}>
        <TableContainer>
          <Table>
            <TableHead>
              <TableRow>
                <TableCell sx={{ fontWeight: 700 }}>Пользователь</TableCell>
                <TableCell sx={{ fontWeight: 700 }}>
                  <TableSortLabel
                    active
                    direction={sortDirection}
                    onClick={toggleSortDirection}
                    sx={{
                      color: 'text.primary',
                      '&.Mui-active': { color: 'text.primary' },
                      '& .MuiTableSortLabel-icon': { color: 'text.secondary !important' },
                    }}
                  >
                    {config.columnLabel}
                  </TableSortLabel>
                </TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {visibleItems.length === 0 && (
                <TableRow>
                  <TableCell colSpan={2} align="center" sx={{ py: 4 }}>
                    <Typography color="text.secondary">Нет пользователей</Typography>
                  </TableCell>
                </TableRow>
              )}
              {visibleItems.map((item) => (
                <TableRow key={`${item.role}-${item.username || item.name}`} hover>
                  <TableCell>
                    <Typography sx={{ fontWeight: 700 }}>{item.name}</Typography>
                    {item.username && (
                      <Typography variant="caption" color="text.secondary">
                        @{item.username}
                      </Typography>
                    )}
                  </TableCell>
                  <TableCell>
                    {item[config.metric]}
                    {tab === 'revision' && item.revisionOrdersWithOpenRequest > 0 && (
                      <Typography variant="caption" color="text.secondary" sx={{ ml: 1 }}>
                        ждут: {item.revisionOrdersWithOpenRequest}
                      </Typography>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      </Paper>
    </Box>
  )
}
