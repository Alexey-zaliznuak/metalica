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

type WorkloadFilter = 'MANAGER' | 'DESIGNER'
type SortDirection = 'asc' | 'desc'
type SortField = 'PRIMARY_ORDERS' | 'SECONDARY_ORDERS'

const FILTER_LABELS: Record<WorkloadFilter, string> = {
  MANAGER: 'Менеджеры',
  DESIGNER: 'Дизайнеры',
}

const DEFAULT_WORKLOAD_SETTINGS = {
  selectedOrderStatusIds: [] as number[],
}

interface WorkloadPageSettings {
  selectedOrderStatusIds: number[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseWorkloadSettings(raw: unknown): WorkloadPageSettings {
  if (!isRecord(raw)) return DEFAULT_WORKLOAD_SETTINGS
  const selectedOrderStatusIds = Array.isArray(raw.selectedOrderStatusIds)
    ? raw.selectedOrderStatusIds
        .map((value) => Number(value))
        .filter((value) => Number.isInteger(value) && value >= 0)
    : []
  return { selectedOrderStatusIds }
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
  const [filter, setFilter] = useState<WorkloadFilter>('MANAGER')
  const [items, setItems] = useState<WorkloadMetric[]>([])
  const [orderStatuses, setOrderStatuses] = useState<BluesalesStatusOption[]>([])
  const [statusesLoaded, setStatusesLoaded] = useState(false)
  const [selectedOrderStatusIds, setSelectedOrderStatusIds] = useState<number[]>([])
  const [statusFilterOpen, setStatusFilterOpen] = useState(false)
  const [sortField, setSortField] = useState<SortField>('PRIMARY_ORDERS')
  const [sortDirection, setSortDirection] = useState<SortDirection>('desc')
  const [initialized, setInitialized] = useState(false)

  // See OrdersPage for the rationale: once the user edits locally we stop
  // overwriting their selection with backend/other-device settings until
  // remount; skipSaveRef prevents echoing applied settings back to the server.
  const dirtyRef = useRef(false)
  const skipSaveRef = useRef(false)

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

    skipSaveRef.current = true
    setSelectedOrderStatusIds(
      normalizeStatusSelection(allStatusIds, parsed.selectedOrderStatusIds),
    )
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
              selectedOrderStatusIds.length > 0 ? selectedOrderStatusIds.join(',') : undefined,
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
  }, [initialized, selectedOrderStatusIds])

  useEffect(() => {
    if (!initialized) return
    if (skipSaveRef.current) {
      skipSaveRef.current = false
      return
    }
    dirtyRef.current = true
    updateFrontendSettings({
      workloadPage: {
        selectedOrderStatusIds,
      } satisfies WorkloadPageSettings,
    })
  }, [initialized, selectedOrderStatusIds, updateFrontendSettings])

  const visibleItems = useMemo(() => {
    return items.filter((item) => item.role === filter)
  }, [filter, items])

  const sortedVisibleItems = useMemo(() => {
    const getPrimaryOrders = (item: WorkloadMetric) =>
      item.role === 'MANAGER' ? item.deliveryOrders : item.sketchOrders
    const getSecondaryOrders = (item: WorkloadMetric) =>
      item.role === 'MANAGER' ? item.onboardingOrders : item.revisionOrders

    const sorted = [...visibleItems].sort((a, b) => {
      const aValue =
        sortField === 'PRIMARY_ORDERS' ? getPrimaryOrders(a) : getSecondaryOrders(a)
      const bValue =
        sortField === 'PRIMARY_ORDERS' ? getPrimaryOrders(b) : getSecondaryOrders(b)
      const diff = aValue - bValue
      if (diff !== 0) {
        return sortDirection === 'asc' ? diff : -diff
      }
      return a.name.localeCompare(b.name, 'ru')
    })

    return sorted
  }, [visibleItems, sortDirection, sortField])

  const managersCount = useMemo(
    () => items.filter((item) => item.role === 'MANAGER').length,
    [items],
  )
  const designersCount = useMemo(
    () => items.filter((item) => item.role === 'DESIGNER').length,
    [items],
  )

  const selectedStatuses = useMemo(
    () => orderStatuses.filter((status) => selectedOrderStatusIds.includes(status.id)),
    [orderStatuses, selectedOrderStatusIds],
  )

  const handleSortChange = (field: SortField) => {
    if (sortField === field) {
      setSortDirection((current) => (current === 'asc' ? 'desc' : 'asc'))
      return
    }
    setSortField(field)
    setSortDirection('desc')
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

      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2} sx={{ mb: 2 }}>
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
            setSelectedOrderStatusIds(values.map((status) => status.id))
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
        <ToggleButtonGroup
          value={filter}
          exclusive
          onChange={(_, value: WorkloadFilter | null) => {
            if (value) setFilter(value)
          }}
          size="small"
        >
          <ToggleButton value="MANAGER">
            {FILTER_LABELS.MANAGER} ({managersCount})
          </ToggleButton>
          <ToggleButton value="DESIGNER">
            {FILTER_LABELS.DESIGNER} ({designersCount})
          </ToggleButton>
        </ToggleButtonGroup>
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
                    active={sortField === 'PRIMARY_ORDERS'}
                    direction={sortField === 'PRIMARY_ORDERS' ? sortDirection : 'desc'}
                    onClick={() => handleSortChange('PRIMARY_ORDERS')}
                    sx={{
                      color: 'text.primary',
                      '&.Mui-active': { color: 'text.primary' },
                      '& .MuiTableSortLabel-icon': { color: 'text.secondary !important' },
                    }}
                  >
                    {filter === 'MANAGER' ? 'Ведение' : 'Эскизы'}
                  </TableSortLabel>
                </TableCell>
                <TableCell sx={{ fontWeight: 700 }}>
                  <TableSortLabel
                    active={sortField === 'SECONDARY_ORDERS'}
                    direction={sortField === 'SECONDARY_ORDERS' ? sortDirection : 'desc'}
                    onClick={() => handleSortChange('SECONDARY_ORDERS')}
                    sx={{
                      color: 'text.primary',
                      '&.Mui-active': { color: 'text.primary' },
                      '& .MuiTableSortLabel-icon': { color: 'text.secondary !important' },
                    }}
                  >
                    {filter === 'MANAGER' ? 'Оформление' : 'Правки'}
                  </TableSortLabel>
                </TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {sortedVisibleItems.length === 0 && (
                <TableRow>
                  <TableCell colSpan={3} align="center" sx={{ py: 4 }}>
                    <Typography color="text.secondary">Нет пользователей</Typography>
                  </TableCell>
                </TableRow>
              )}
              {sortedVisibleItems.map((item) => (
                <TableRow key={`${item.role}-${item.username || item.name}`} hover>
                  <TableCell>
                    <Typography sx={{ fontWeight: 700 }}>{item.name}</Typography>
                    {item.username && (
                      <Typography variant="caption" color="text.secondary">
                        @{item.username}
                      </Typography>
                    )}
                  </TableCell>
                  <TableCell>{item.role === 'MANAGER' ? item.deliveryOrders : item.sketchOrders}</TableCell>
                  <TableCell>
                    {item.role === 'MANAGER' ? item.onboardingOrders : item.revisionOrders}
                    {item.role === 'DESIGNER' && (
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
