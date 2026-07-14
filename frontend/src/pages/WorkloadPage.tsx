import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Alert,
  Autocomplete,
  Box,
  CircularProgress,
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
import { useAuth } from '../auth/AuthContext'
import type { BluesalesStatusOption, WorkloadMetric } from '../api/types'

type WorkloadTab = 'sketch' | 'revision' | 'delivery' | 'onboarding'
type SortDirection = 'asc' | 'desc'
type WorkloadMetricKey =
  | 'sketchOrders'
  | 'revisionOrders'
  | 'deliveryOrders'
  | 'onboardingOrders'

const WORKLOAD_TABS: WorkloadTab[] = ['sketch', 'revision', 'delivery', 'onboarding']

const TAB_CONFIG: Record<
  WorkloadTab,
  {
    label: string
    role: 'DESIGNER' | 'MANAGER'
    metric: WorkloadMetricKey
    columnLabel: string
  }
> = {
  sketch: {
    label: 'Художники · Эскизы',
    role: 'DESIGNER',
    metric: 'sketchOrders',
    columnLabel: 'Эскизы',
  },
  revision: {
    label: 'Художники · Правки',
    role: 'DESIGNER',
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

const DEFAULT_STATUS_SELECTIONS: StatusSelections = {
  sketch: [],
  revision: [],
  delivery: [],
  onboarding: [],
}

interface WorkloadTabSettings {
  selectedOrderStatusIds: number[]
}

type WorkloadPageSettings = Record<WorkloadTab, WorkloadTabSettings>

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseStatusIds(raw: unknown): number[] {
  if (!Array.isArray(raw)) return []
  return raw
    .map((value) => Number(value))
    .filter((value, index, arr) => Number.isInteger(value) && value >= 0 && arr.indexOf(value) === index)
}

function parseWorkloadSettings(raw: unknown): StatusSelections {
  const result: StatusSelections = {
    sketch: [],
    revision: [],
    delivery: [],
    onboarding: [],
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

function normalizeStatusSelection(availableStatusIds: number[], selectedRaw: number[]) {
  const available = new Set(availableStatusIds)
  const normalized = selectedRaw.filter(
    (id, index, arr) => available.has(id) && arr.indexOf(id) === index,
  )
  return normalized.length > 0 ? normalized : availableStatusIds
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
      } catch {
        if (!active) return
        setError('Не удалось загрузить статусы заказов')
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
    const parsed = parseWorkloadSettings(
      isRecord(settings) ? settings.workloadPage : undefined,
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
    setInitialized(true)
  }, [statusesLoaded, orderStatuses, user?.frontendSettings])

  useEffect(() => {
    if (!initialized) return
    let active = true
    ;(async () => {
      setLoading(true)
      setError(null)
      try {
        const { data } = await client.get<WorkloadMetric[]>('/metrics/workload', {
          params: {
            orderStatusIds:
              activeSelection.length > 0 ? activeSelection.join(',') : undefined,
          },
        })
        if (!active) return
        setItems(data)
      } catch {
        if (active) {
          setError('Не удалось загрузить нагрузку пользователей')
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
  }, [initialized, activeSelection])

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
      } satisfies WorkloadPageSettings,
    })
  }, [initialized, statusSelections, updateFrontendSettings])

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
          Текущая загрузка менеджеров и дизайнеров по назначенным заказам
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
            if (values.length === 0) return
            const ids = values.map((status) => status.id)
            setStatusSelections((prev) => ({ ...prev, [tab]: ids }))
          }}
          size="small"
          sx={{ minWidth: { xs: '100%', sm: 360 } }}
          renderInput={(params) => <TextField {...params} placeholder="Выбрать статусы" />}
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
