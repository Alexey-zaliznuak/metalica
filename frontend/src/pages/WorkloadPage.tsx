import { useEffect, useMemo, useState } from 'react'
import {
  Alert,
  Box,
  Checkbox,
  CircularProgress,
  FormControl,
  InputLabel,
  ListItemText,
  MenuItem,
  OutlinedInput,
  Paper,
  Select,
  type SelectChangeEvent,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  ToggleButton,
  ToggleButtonGroup,
  Typography,
} from '@mui/material'
import client, { USER_KEY } from '../api/client'
import { useAuth } from '../auth/AuthContext'
import type { BluesalesStatusOption, User, WorkloadMetric } from '../api/types'

type WorkloadFilter = 'MANAGER' | 'DESIGNER'

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
  const { user } = useAuth()
  const [loading, setLoading] = useState(true)
  const [statusesLoading, setStatusesLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState<WorkloadFilter>('MANAGER')
  const [items, setItems] = useState<WorkloadMetric[]>([])
  const [orderStatuses, setOrderStatuses] = useState<BluesalesStatusOption[]>([])
  const [selectedOrderStatusIds, setSelectedOrderStatusIds] = useState<number[]>([])
  const [frontendSettingsBase, setFrontendSettingsBase] = useState<
    Record<string, unknown>
  >({})
  const [initialized, setInitialized] = useState(false)

  useEffect(() => {
    let active = true
    ;(async () => {
      setStatusesLoading(true)
      setError(null)
      try {
        const { data } = await client.get<BluesalesStatusOption[]>('/orders/order-statuses')
        if (!active) return
        const allStatusIds = data.map((status) => status.id)
        const baseSettings = isRecord(user?.frontendSettings) ? user.frontendSettings : {}
        const parsed = parseWorkloadSettings(
          isRecord(baseSettings.workloadPage) ? baseSettings.workloadPage : undefined,
        )
        setOrderStatuses(data)
        setFrontendSettingsBase(baseSettings)
        setSelectedOrderStatusIds(normalizeStatusSelection(allStatusIds, parsed.selectedOrderStatusIds))
        setInitialized(true)
      } catch {
        if (!active) return
        setError('Не удалось загрузить статусы заказов')
      } finally {
        if (active) {
          setStatusesLoading(false)
        }
      }
    })()
    return () => {
      active = false
    }
  }, [user?.frontendSettings])

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
    const timeout = setTimeout(() => {
      const frontendSettings = {
        ...frontendSettingsBase,
        workloadPage: {
          selectedOrderStatusIds,
        },
      }
      void client.patch<User>('/auth/frontend-settings', { frontendSettings }).then(({ data }) => {
        const rawUser = localStorage.getItem(USER_KEY)
        if (!rawUser) return
        try {
          const cached = JSON.parse(rawUser) as User
          localStorage.setItem(
            USER_KEY,
            JSON.stringify({ ...cached, frontendSettings: data.frontendSettings }),
          )
        } catch {
          /* ignore invalid cache */
        }
      })
    }, 500)
    return () => clearTimeout(timeout)
  }, [initialized, selectedOrderStatusIds, frontendSettingsBase])

  const visibleItems = useMemo(() => {
    return items.filter((item) => item.role === filter)
  }, [filter, items])

  const managersCount = useMemo(
    () => items.filter((item) => item.role === 'MANAGER').length,
    [items],
  )
  const designersCount = useMemo(
    () => items.filter((item) => item.role === 'DESIGNER').length,
    [items],
  )

  const statusNameById = useMemo(() => {
    const map = new Map<number, string>()
    orderStatuses.forEach((status) => map.set(status.id, status.name))
    return map
  }, [orderStatuses])

  const selectedStatusLabels = useMemo(
    () =>
      selectedOrderStatusIds
        .map((id) => statusNameById.get(id))
        .filter((name): name is string => Boolean(name)),
    [selectedOrderStatusIds, statusNameById],
  )

  if (loading || statusesLoading) {
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
        <FormControl size="small" sx={{ minWidth: { xs: '100%', sm: 360 } }}>
          <InputLabel id="workload-status-filter-label">Статусы заказов</InputLabel>
          <Select
            labelId="workload-status-filter-label"
            multiple
            value={selectedOrderStatusIds.map(String)}
            onChange={(event: SelectChangeEvent<string[]>) => {
              const raw = event.target.value
              const values = (typeof raw === 'string' ? raw.split(',') : raw)
                .map((value) => Number(value))
                .filter((value) => Number.isInteger(value) && value >= 0)
              if (values.length === 0) return
              setSelectedOrderStatusIds(values)
            }}
            input={<OutlinedInput label="Статусы заказов" />}
            renderValue={() =>
              selectedStatusLabels.length > 0
                ? selectedStatusLabels.join(', ')
                : 'Статусы не выбраны'
            }
          >
            {orderStatuses.map((status) => {
              const checked = selectedOrderStatusIds.includes(status.id)
              return (
                <MenuItem key={status.id} value={String(status.id)}>
                  <Checkbox checked={checked} />
                  <ListItemText primary={status.name} />
                </MenuItem>
              )
            })}
          </Select>
        </FormControl>
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
      </Stack>

      <Paper variant="outlined" sx={{ borderRadius: 1.5, overflow: 'hidden' }}>
        <TableContainer>
          <Table>
            <TableHead>
              <TableRow>
                <TableCell sx={{ fontWeight: 700 }}>Пользователь</TableCell>
                <TableCell sx={{ fontWeight: 700 }}>
                  {filter === 'MANAGER' ? 'Ведение' : 'Эскизы'}
                </TableCell>
                <TableCell sx={{ fontWeight: 700 }}>
                  {filter === 'MANAGER' ? 'Оформление' : 'Правки'}
                </TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {visibleItems.length === 0 && (
                <TableRow>
                  <TableCell colSpan={4} align="center" sx={{ py: 4 }}>
                    <Typography color="text.secondary">Нет пользователей</Typography>
                  </TableCell>
                </TableRow>
              )}
              {visibleItems.map((item) => (
                <TableRow key={item.userId} hover>
                  <TableCell>
                    <Typography sx={{ fontWeight: 700 }}>{item.name}</Typography>
                    <Typography variant="caption" color="text.secondary">
                      @{item.username}
                    </Typography>
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
