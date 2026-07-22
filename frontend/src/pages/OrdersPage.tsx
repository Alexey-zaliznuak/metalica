import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type UIEvent,
} from 'react'
import {
  Alert,
  Autocomplete,
  Badge,
  Box,
  Button,
  Checkbox,
  Chip,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  Divider,
  FormControlLabel,
  InputAdornment,
  List,
  ListItemButton,
  ListItemText,
  Paper,
  Stack,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material'
import SearchIcon from '@mui/icons-material/Search'
import EditNoteIcon from '@mui/icons-material/EditNote'
import ViewWeekIcon from '@mui/icons-material/ViewWeek'
import SyncAltIcon from '@mui/icons-material/SyncAlt'
import PeopleAltIcon from '@mui/icons-material/PeopleAlt'
import { useNavigate } from 'react-router-dom'
import client from '../api/client'
import { useAuth } from '../auth/AuthContext'
import type {
  BluesalesStatusOption,
  Order,
  OrderAssigneesResponse,
  OrderFilterOptions,
  OrderStatusSyncResponse,
  OrdersBoardSettings,
  OrdersColumnResponse,
} from '../api/types'
import { formatLastActivity } from '../utils'

const NO_ORDER_STATUS_COLUMN_ID = -1

// Статус заказа, для которого можно отключить фильтр по художникам.
const SKETCH_STATUS_NAME = 'Готовим эскиз'

function isSketchStatusName(name: string | undefined): boolean {
  return (name ?? '').trim().toLowerCase() === SKETCH_STATUS_NAME.toLowerCase()
}

// Сколько заказов запрашиваем у сервера за одну «страницу» колонки.
const PAGE_SIZE = 50
// Сколько карточек добавляем в DOM за один шаг прокрутки (клиентское окно).
const RENDER_STEP = 10
// Высота области прокрутки колонки — чтобы на экране было видно ~4 карточки.
const COLUMN_MAX_HEIGHT = 520

const DEFAULT_BOARD_SETTINGS: OrdersBoardSettings = {
  selectedOrderStatusIds: [],
  columnOrder: [],
  searchQuery: '',
  showNoOrderStatusColumn: true,
  disableDesignerFilterForSketch: false,
}

interface BoardColumn {
  id: number
  name: string
  isNoOrderStatus: boolean
}

interface ColumnState {
  items: Order[]
  page: number
  total: number
  hasMore: boolean
  loading: boolean
  renderCount: number
  loaded: boolean
}

const EMPTY_COLUMN_STATE: ColumnState = {
  items: [],
  page: 0,
  total: 0,
  hasMore: false,
  loading: false,
  renderCount: RENDER_STEP,
  loaded: false,
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseBoardSettings(raw: unknown): OrdersBoardSettings {
  if (!isRecord(raw)) return DEFAULT_BOARD_SETTINGS

  const selectedOrderStatusIds = Array.isArray(raw.selectedOrderStatusIds)
    ? raw.selectedOrderStatusIds
        .map((value) => Number(value))
        .filter((value) => Number.isInteger(value) && value >= 0)
    : Array.isArray(raw.selectedCrmStatusIds)
      ? raw.selectedCrmStatusIds
          .map((value) => Number(value))
          .filter((value) => Number.isInteger(value) && value >= 0)
    : []

  const columnOrder = Array.isArray(raw.columnOrder)
    ? raw.columnOrder
        .map((value) => Number(value))
        .filter((value) => Number.isInteger(value) && value >= NO_ORDER_STATUS_COLUMN_ID)
    : []

  const searchQuery = typeof raw.searchQuery === 'string' ? raw.searchQuery : ''
  const showNoOrderStatusColumn =
    typeof raw.showNoOrderStatusColumn === 'boolean'
      ? raw.showNoOrderStatusColumn
      : typeof raw.showNoCrmColumn === 'boolean'
        ? raw.showNoCrmColumn
        : true

  const disableDesignerFilterForSketch =
    typeof raw.disableDesignerFilterForSketch === 'boolean'
      ? raw.disableDesignerFilterForSketch
      : false

  return {
    selectedOrderStatusIds,
    columnOrder,
    searchQuery,
    showNoOrderStatusColumn,
    disableDesignerFilterForSketch,
  }
}

function normalizeColumns(
  allStatusIds: number[],
  selectedIdsRaw: number[],
  columnOrderRaw: number[],
  showNoOrderStatusColumn: boolean,
): { selectedIds: number[]; columnOrder: number[] } {
  const available = new Set(allStatusIds)
  const selected = selectedIdsRaw
    .filter((id, index, arr) => available.has(id) && arr.indexOf(id) === index)
  const selectedIds = selected.length > 0 ? selected : allStatusIds
  const requiredIds = showNoOrderStatusColumn
    ? [...selectedIds, NO_ORDER_STATUS_COLUMN_ID]
    : selectedIds
  const requiredSet = new Set(requiredIds)
  const ordered = columnOrderRaw.filter(
    (id, index, arr) => requiredSet.has(id) && arr.indexOf(id) === index,
  )
  const missing = requiredIds.filter((id) => !ordered.includes(id))
  return { selectedIds, columnOrder: [...ordered, ...missing] }
}

interface OrderCardProps {
  order: Order
  isMoving: boolean
  onOpen: (id: number) => void
  onDragStart: (id: number, canMove: boolean) => void
  onDragEnd: () => void
}

const OrderCard = memo(function OrderCard({
  order,
  isMoving,
  onOpen,
  onDragStart,
  onDragEnd,
}: OrderCardProps) {
  const canMoveCard = order.source === 'BLUESALES'
  return (
    <Paper
      variant="outlined"
      draggable={canMoveCard}
      onDragStart={() => onDragStart(order.id, canMoveCard)}
      onDragEnd={onDragEnd}
      onClick={() => onOpen(order.id)}
      sx={{
        p: 1.2,
        borderRadius: 1.3,
        cursor: 'pointer',
        opacity: isMoving ? 0.6 : 1,
        '&:hover': { borderColor: 'primary.main', boxShadow: 1 },
      }}
    >
      <Stack direction="row" alignItems="center" justifyContent="space-between" spacing={1}>
        <Typography variant="subtitle2" sx={{ fontWeight: 700 }}>
          {order.orderNumber}
        </Typography>
        {order.hasUrgentTag && (
          <Chip
            size="small"
            label="Срочно"
            sx={{ bgcolor: 'error.main', color: '#fff', fontWeight: 700 }}
          />
        )}
      </Stack>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 1, minHeight: 20 }}>
        {order.title || 'Без названия'}
      </Typography>
      <Stack direction="row" spacing={1} alignItems="center" justifyContent="space-between">
        <Chip
          size="small"
          label={order.orderStatus ?? '—'}
          color={order.orderStatus ? 'info' : 'default'}
          variant={order.orderStatus ? 'filled' : 'outlined'}
        />
        <Tooltip
          title={
            order.openRevisions > 0
              ? `Открытых правок: ${order.openRevisions}`
              : 'Все правки закрыты'
          }
        >
          <Badge
            color="warning"
            badgeContent={order.openRevisions}
            invisible={order.openRevisions === 0}
            overlap="circular"
          >
            <Chip
              size="small"
              icon={<EditNoteIcon />}
              label={order.revisionCount}
              variant="outlined"
            />
          </Badge>
        </Tooltip>
      </Stack>
      <Stack direction="row" alignItems="center" spacing={0.5} sx={{ mt: 0.8 }}>
        {order.orderStatusSync ? (
          <>
            {order.orderStatusSync.state === 'pending' ? (
              <CircularProgress size={12} />
            ) : (
              <SyncAltIcon sx={{ fontSize: 13, color: 'warning.main' }} />
            )}
            <Tooltip title={order.orderStatusSync.lastError ?? ''}>
              <Typography
                variant="caption"
                color={order.orderStatusSync.state === 'retrying' ? 'warning.main' : 'text.secondary'}
              >
                {order.orderStatusSync.state === 'retrying'
                  ? `Повтор отправки в BlueSales (${order.orderStatusSync.attempts})`
                  : 'Отправляется в BlueSales'}
              </Typography>
            </Tooltip>
          </>
        ) : (
          <>
            <SyncAltIcon sx={{ fontSize: 12, color: 'text.secondary' }} />
            <Typography variant="caption" color="text.secondary">
              {canMoveCard ? 'Можно перетаскивать' : 'Ручной заказ: статус не переносится'}
            </Typography>
          </>
        )}
      </Stack>
      <Typography variant="caption" color="text.secondary" sx={{ mt: 0.4 }}>
        {formatLastActivity(order.lastMessageAt)}
      </Typography>
    </Paper>
  )
})

interface BoardColumnViewProps {
  column: BoardColumn
  state: ColumnState
  isColumnDragging: boolean
  movingOrderId: number | null
  onColumnDragStart: (id: number) => void
  onColumnDrop: (id: number) => void
  onColumnDragEnd: () => void
  onOrderDrop: (columnId: number) => void
  onOpenOrder: (id: number) => void
  onOrderDragStart: (id: number, canMove: boolean) => void
  onOrderDragEnd: () => void
  onNearBottom: (columnId: number) => void
}

const BoardColumnView = memo(function BoardColumnView({
  column,
  state,
  isColumnDragging,
  movingOrderId,
  onColumnDragStart,
  onColumnDrop,
  onColumnDragEnd,
  onOrderDrop,
  onOpenOrder,
  onOrderDragStart,
  onOrderDragEnd,
  onNearBottom,
}: BoardColumnViewProps) {
  const visibleOrders =
    state.renderCount >= state.items.length
      ? state.items
      : state.items.slice(0, state.renderCount)
  const canLoadMore = state.renderCount < state.items.length || state.hasMore

  const handleScroll = useCallback(
    (event: UIEvent<HTMLDivElement>) => {
      const el = event.currentTarget
      if (el.scrollHeight - el.scrollTop - el.clientHeight < 300) {
        onNearBottom(column.id)
      }
    },
    [column.id, onNearBottom],
  )

  return (
    <Paper
      variant="outlined"
      draggable
      onDragStart={() => onColumnDragStart(column.id)}
      onDragOver={(event: DragEvent<HTMLDivElement>) => event.preventDefault()}
      onDrop={() => onColumnDrop(column.id)}
      onDragEnd={onColumnDragEnd}
      sx={{
        width: 320,
        flexShrink: 0,
        borderRadius: 1.5,
        borderColor: isColumnDragging ? 'primary.main' : 'divider',
        background: '#fff',
      }}
    >
      <Stack
        direction="row"
        alignItems="center"
        justifyContent="space-between"
        sx={{ px: 1.5, py: 1.2 }}
      >
        <Typography variant="subtitle2" sx={{ fontWeight: 700 }}>
          {column.name}
        </Typography>
        <Chip size="small" label={state.total} />
      </Stack>
      <Divider />
      <Stack
        spacing={1}
        sx={{ p: 1, maxHeight: COLUMN_MAX_HEIGHT, overflowY: 'auto' }}
        onScroll={handleScroll}
        onDragOver={(event: DragEvent<HTMLDivElement>) => event.preventDefault()}
        onDrop={() => onOrderDrop(column.id)}
      >
        {state.items.length === 0 && !state.loading && (
          <Typography
            variant="body2"
            color="text.secondary"
            sx={{ textAlign: 'center', py: 3 }}
          >
            Нет заказов
          </Typography>
        )}
        {visibleOrders.map((order) => (
          <OrderCard
            key={order.id}
            order={order}
            isMoving={movingOrderId === order.id}
            onOpen={onOpenOrder}
            onDragStart={onOrderDragStart}
            onDragEnd={onOrderDragEnd}
          />
        ))}
        {state.loading && (
          <Box sx={{ display: 'flex', justifyContent: 'center', py: 2 }}>
            <CircularProgress size={22} />
          </Box>
        )}
        {!state.loading && canLoadMore && (
          <Typography
            variant="caption"
            color="text.secondary"
            sx={{ textAlign: 'center', py: 1 }}
          >
            Показано {visibleOrders.length} из {state.total} — прокрутите, чтобы
            загрузить ещё
          </Typography>
        )}
      </Stack>
    </Paper>
  )
})

export default function OrdersPage() {
  const navigate = useNavigate()
  const { user, updateFrontendSettings } = useAuth()

  const [columnData, setColumnData] = useState<Record<number, ColumnState>>({})
  const [error, setError] = useState<string | null>(null)
  const [bootError, setBootError] = useState<string | null>(null)

  const [search, setSearch] = useState('')
  const [selectedDeliveryManagers, setSelectedDeliveryManagers] = useState<string[]>([])
  const [selectedOnboardingManagers, setSelectedOnboardingManagers] = useState<string[]>([])
  const [selectedSketchDesigners, setSelectedSketchDesigners] = useState<string[]>([])
  const [selectedRevisionDesigners, setSelectedRevisionDesigners] = useState<string[]>([])
  const [disableDesignerFilterForSketch, setDisableDesignerFilterForSketch] = useState(false)
  const [peopleFilterOpen, setPeopleFilterOpen] = useState(false)
  const [sketchDesigners, setSketchDesigners] = useState<
    OrderAssigneesResponse['sketchDesigners']
  >([])
  const [revisionDesigners, setRevisionDesigners] = useState<
    OrderAssigneesResponse['revisionDesigners']
  >([])
  const [managerOptions, setManagerOptions] = useState<OrderFilterOptions>({
    deliveryManagers: [],
    onboardingManagers: [],
  })
  const [orderStatuses, setOrderStatuses] = useState<BluesalesStatusOption[]>([])
  const [statusesLoaded, setStatusesLoaded] = useState(false)
  const [selectedOrderStatusIds, setSelectedOrderStatusIds] = useState<number[]>([])
  const [showNoOrderStatusColumn, setShowNoOrderStatusColumn] = useState(true)
  const [columnOrder, setColumnOrder] = useState<number[]>([])
  const [draggingColumnId, setDraggingColumnId] = useState<number | null>(null)
  const [movingOrderId, setMovingOrderId] = useState<number | null>(null)
  const [columnsDialogOpen, setColumnsDialogOpen] = useState(false)
  const [initialized, setInitialized] = useState(false)

  // Актуальное состояние колонок для колбэков (скролл/drop), чтобы не тянуть
  // columnData в зависимости и не пересоздавать хендлеры.
  const columnDataRef = useRef<Record<number, ColumnState>>(columnData)
  useEffect(() => {
    columnDataRef.current = columnData
  }, [columnData])

  // id перетаскиваемой карточки — в ref: перетаскивание не должно ререндерить доску.
  const draggingOrderIdRef = useRef<number | null>(null)
  // Зеркало draggingColumnId для стабильного drop-хендлера колонок.
  const draggingColumnIdRef = useRef<number | null>(null)

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const dirtyRef = useRef(false)
  const skipSaveRef = useRef(false)

  useEffect(() => {
    let active = true
    void client
      .get<BluesalesStatusOption[]>('/orders/order-statuses')
      .then((res) => {
        if (!active) return
        setOrderStatuses(res.data)
        setStatusesLoaded(true)
      })
      .catch(() => {
        if (!active) return
        setBootError('Не удалось загрузить статусы заказов')
        setStatusesLoaded(true)
      })
    return () => {
      active = false
    }
  }, [])

  useEffect(() => {
    let active = true
    void client
      .get<OrderAssigneesResponse>('/orders/assignees')
      .then((res) => {
        if (!active) return
        setSketchDesigners(res.data.sketchDesigners)
        setRevisionDesigners(res.data.revisionDesigners)
      })
      .catch(() => {
        // Художников в фильтре просто не покажем, если запрос упал.
      })
    return () => {
      active = false
    }
  }, [])

  useEffect(() => {
    let active = true
    void client
      .get<OrderFilterOptions>('/orders/filter-options')
      .then((res) => {
        if (!active) return
        setManagerOptions(res.data)
      })
      .catch(() => {
        // Опции менеджеров необязательны — фильтр останется пустым.
      })
    return () => {
      active = false
    }
  }, [])

  // Применение настроек доски (источник истины — бэкенд).
  useEffect(() => {
    if (!statusesLoaded) return
    if (dirtyRef.current) return

    const settings = user?.frontendSettings
    const parsed = parseBoardSettings(
      isRecord(settings) ? settings.ordersBoard : undefined,
    )
    const allOrderStatusIds = orderStatuses.map((status) => status.id)
    const normalized = normalizeColumns(
      allOrderStatusIds,
      parsed.selectedOrderStatusIds,
      parsed.columnOrder,
      parsed.showNoOrderStatusColumn,
    )

    skipSaveRef.current = true
    setSearch(parsed.searchQuery)
    setShowNoOrderStatusColumn(parsed.showNoOrderStatusColumn)
    setDisableDesignerFilterForSketch(parsed.disableDesignerFilterForSketch)
    setSelectedOrderStatusIds(normalized.selectedIds)
    setColumnOrder(normalized.columnOrder)
    setInitialized(true)
  }, [statusesLoaded, orderStatuses, user?.frontendSettings])

  useEffect(() => {
    if (!initialized) return
    if (skipSaveRef.current) {
      skipSaveRef.current = false
      return
    }
    dirtyRef.current = true
    updateFrontendSettings({
      ordersBoard: {
        selectedOrderStatusIds,
        columnOrder,
        searchQuery: search,
        showNoOrderStatusColumn,
        disableDesignerFilterForSketch,
      } satisfies OrdersBoardSettings,
    })
  }, [
    initialized,
    search,
    selectedOrderStatusIds,
    showNoOrderStatusColumn,
    disableDesignerFilterForSketch,
    columnOrder,
    updateFrontendSettings,
  ])

  const boardColumns = useMemo<BoardColumn[]>(() => {
    const byId = new Map(orderStatuses.map((status) => [status.id, status]))
    return columnOrder
      .filter(
        (id) =>
          id === NO_ORDER_STATUS_COLUMN_ID ||
          (id >= 0 && selectedOrderStatusIds.includes(id) && byId.has(id)),
      )
      .map((id) =>
        id === NO_ORDER_STATUS_COLUMN_ID
          ? { id, name: 'Без статуса заказа', isNoOrderStatus: true }
          : { id, name: byId.get(id)!.name, isNoOrderStatus: false },
      )
  }, [orderStatuses, columnOrder, selectedOrderStatusIds])

  const deliveryManagerOptions = managerOptions.deliveryManagers
  const onboardingManagerOptions = managerOptions.onboardingManagers

  const sketchDesignerOptions = useMemo(() => {
    const set = new Set<string>()
    for (const designer of sketchDesigners) {
      const name = designer.name?.trim()
      if (name) set.add(name)
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b, 'ru'))
  }, [sketchDesigners])

  const revisionDesignerOptions = useMemo(() => {
    const set = new Set<string>()
    for (const designer of revisionDesigners) {
      const name = designer.name?.trim()
      if (name) set.add(name)
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b, 'ru'))
  }, [revisionDesigners])

  const activePeopleFilterCount = useMemo(
    () =>
      selectedDeliveryManagers.length +
      selectedOnboardingManagers.length +
      selectedSketchDesigners.length +
      selectedRevisionDesigners.length,
    [
      selectedDeliveryManagers,
      selectedOnboardingManagers,
      selectedSketchDesigners,
      selectedRevisionDesigners,
    ],
  )

  const orderStatusNameById = useMemo(() => {
    const map = new Map<number, string>()
    orderStatuses.forEach((status) => map.set(status.id, status.name))
    return map
  }, [orderStatuses])

  const buildFilterParams = useCallback((): Record<string, unknown> => {
    const params: Record<string, unknown> = {}
    const query = search.trim()
    if (query) params.q = query
    if (selectedDeliveryManagers.length) params.deliveryManagers = selectedDeliveryManagers
    if (selectedOnboardingManagers.length)
      params.onboardingManagers = selectedOnboardingManagers
    if (selectedSketchDesigners.length) params.sketchDesigners = selectedSketchDesigners
    if (selectedRevisionDesigners.length)
      params.revisionDesigners = selectedRevisionDesigners
    return params
  }, [
    search,
    selectedDeliveryManagers,
    selectedOnboardingManagers,
    selectedSketchDesigners,
    selectedRevisionDesigners,
  ])

  const fetchColumnPage = useCallback(
    async (columnId: number, page: number, replace: boolean) => {
      setColumnData((prev) => ({
        ...prev,
        [columnId]: { ...(prev[columnId] ?? EMPTY_COLUMN_STATE), loading: true },
      }))

      const params = buildFilterParams()
      params.page = page
      params.limit = PAGE_SIZE
      if (columnId === NO_ORDER_STATUS_COLUMN_ID) params.noStatus = 'true'
      else params.orderStatusId = columnId

      // Для колонки «Готовим эскиз» просим бэкенд игнорировать фильтр по
      // художникам, если это включено в настройках доски.
      if (
        disableDesignerFilterForSketch &&
        isSketchStatusName(orderStatusNameById.get(columnId))
      ) {
        params.ignoreDesigners = 'true'
      }

      try {
        const { data } = await client.get<OrdersColumnResponse>('/orders', { params })
        setColumnData((prev) => {
          const existing = prev[columnId]
          const items = replace ? data.items : [...(existing?.items ?? []), ...data.items]
          const prevRender = replace ? 0 : existing?.renderCount ?? 0
          const renderCount = Math.min(prevRender + RENDER_STEP, items.length)
          return {
            ...prev,
            [columnId]: {
              items,
              page: data.page,
              total: data.total,
              hasMore: data.hasMore,
              loading: false,
              renderCount: Math.max(renderCount, Math.min(RENDER_STEP, items.length)),
              loaded: true,
            },
          }
        })
      } catch {
        setColumnData((prev) => ({
          ...prev,
          [columnId]: { ...(prev[columnId] ?? EMPTY_COLUMN_STATE), loading: false, loaded: true },
        }))
        setError('Не удалось загрузить заказы')
      }
    },
    [buildFilterParams, disableDesignerFilterForSketch, orderStatusNameById],
  )

  const reloadAll = useCallback(() => {
    boardColumns.forEach((column) => {
      void fetchColumnPage(column.id, 1, true)
    })
  }, [boardColumns, fetchColumnPage])

  useEffect(() => {
    if (!initialized) return
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(reloadAll, 300)
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
    }
  }, [initialized, reloadAll])

  const pendingSyncOrderIds = useMemo(
    () =>
      Array.from(
        new Set(
          Object.values(columnData)
            .flatMap((state) => state.items)
            .filter((order) => order.orderStatusSync)
            .map((order) => order.id),
        ),
      ),
    [columnData],
  )

  useEffect(() => {
    if (pendingSyncOrderIds.length === 0) return
    let cancelled = false
    let timer: number | undefined
    const poll = async () => {
      try {
        const { data } = await client.get<OrderStatusSyncResponse[]>('/orders/status-sync', {
          params: { ids: pendingSyncOrderIds.join(',') },
        })
        if (cancelled) return
        const byId = new Map(data.map((item) => [item.orderId, item.orderStatusSync]))
        setColumnData((prev) =>
          Object.fromEntries(
            Object.entries(prev).map(([columnId, state]) => [
              columnId,
              {
                ...state,
                items: state.items.map((order) =>
                  byId.has(order.id)
                    ? { ...order, orderStatusSync: byId.get(order.id) ?? null }
                    : order,
                ),
              },
            ]),
          ),
        )
      } catch {
        // Очередь durable; временная ошибка polling не должна менять карточки.
      }
      if (!cancelled) timer = window.setTimeout(poll, 2000)
    }
    timer = window.setTimeout(poll, 2000)
    return () => {
      cancelled = true
      if (timer !== undefined) window.clearTimeout(timer)
    }
  }, [pendingSyncOrderIds])

  const handleColumnNearBottom = useCallback(
    (columnId: number) => {
      const state = columnDataRef.current[columnId]
      if (!state || state.loading) return
      if (state.renderCount < state.items.length) {
        setColumnData((prev) => {
          const current = prev[columnId]
          if (!current) return prev
          return {
            ...prev,
            [columnId]: {
              ...current,
              renderCount: Math.min(current.renderCount + RENDER_STEP, current.items.length),
            },
          }
        })
        return
      }
      if (state.hasMore) {
        void fetchColumnPage(columnId, state.page + 1, false)
      }
    },
    [fetchColumnPage],
  )

  const moveOrderToColumn = useCallback(
    async (orderId: number, targetColumnId: number) => {
      if (targetColumnId === NO_ORDER_STATUS_COLUMN_ID) return

      // Ищем исходную колонку и заказ в текущем состоянии.
      let sourceColumnId: number | null = null
      let sourceOrder: Order | null = null
      for (const [colId, state] of Object.entries(columnDataRef.current)) {
        const found = state.items.find((o) => o.id === orderId)
        if (found) {
          sourceColumnId = Number(colId)
          sourceOrder = found
          break
        }
      }
      if (sourceColumnId === null || sourceOrder === null) return
      if (sourceColumnId === targetColumnId) return

      const nextStatus = orderStatusNameById.get(targetColumnId) ?? null
      const movedOrder: Order = {
        ...sourceOrder,
        orderStatusId: targetColumnId,
        orderStatus: nextStatus,
      }
      const fromColumnId = sourceColumnId
      const originalOrder = sourceOrder

      setMovingOrderId(orderId)
      // Оптимистично переносим карточку между колонками.
      setColumnData((prev) => {
        const next = { ...prev }
        const from = prev[fromColumnId]
        if (from) {
          next[fromColumnId] = {
            ...from,
            items: from.items.filter((o) => o.id !== orderId),
            total: Math.max(from.total - 1, 0),
            renderCount: Math.max(from.renderCount - 1, RENDER_STEP),
          }
        }
        const to = prev[targetColumnId] ?? EMPTY_COLUMN_STATE
        next[targetColumnId] = {
          ...to,
          items: [movedOrder, ...to.items.filter((o) => o.id !== orderId)],
          total: to.total + 1,
          renderCount: Math.max(to.renderCount, RENDER_STEP),
        }
        return next
      })

      try {
        const { data } = await client.patch<Order>(`/orders/${orderId}/order-status`, {
          statusId: targetColumnId,
        })
        setColumnData((prev) => {
          const to = prev[targetColumnId]
          if (!to) return prev
          return {
            ...prev,
            [targetColumnId]: {
              ...to,
              items: to.items.map((o) => (o.id === orderId ? data : o)),
            },
          }
        })
      } catch {
        // Откат: возвращаем заказ в исходную колонку.
        setColumnData((prev) => {
          const next = { ...prev }
          const to = prev[targetColumnId]
          if (to) {
            next[targetColumnId] = {
              ...to,
              items: to.items.filter((o) => o.id !== orderId),
              total: Math.max(to.total - 1, 0),
            }
          }
          const from = prev[fromColumnId] ?? EMPTY_COLUMN_STATE
          next[fromColumnId] = {
            ...from,
            items: [originalOrder, ...from.items.filter((o) => o.id !== orderId)],
            total: from.total + 1,
          }
          return next
        })
        setError(
          'Не удалось переместить заказ. Для ручных заказов статус в BlueSales не меняется.',
        )
      } finally {
        setMovingOrderId(null)
      }
    },
    [orderStatusNameById],
  )

  const handleOpenOrder = useCallback((id: number) => navigate(`/orders/${id}`), [navigate])

  const handleOrderDragStart = useCallback((id: number, canMove: boolean) => {
    draggingOrderIdRef.current = canMove ? id : null
  }, [])

  const handleOrderDragEnd = useCallback(() => {
    draggingOrderIdRef.current = null
  }, [])

  const handleOrderDrop = useCallback(
    (columnId: number) => {
      const orderId = draggingOrderIdRef.current
      if (orderId != null) {
        void moveOrderToColumn(orderId, columnId)
      }
    },
    [moveOrderToColumn],
  )

  const handleColumnDragStart = useCallback((id: number) => {
    draggingColumnIdRef.current = id
    setDraggingColumnId(id)
  }, [])

  const handleColumnDragEnd = useCallback(() => {
    draggingColumnIdRef.current = null
    setDraggingColumnId(null)
  }, [])

  const handleColumnDrop = useCallback((targetColumnId: number) => {
    const draggedId = draggingColumnIdRef.current
    if (draggedId == null || draggedId === targetColumnId) return
    setColumnOrder((prev) => {
      const withoutDragged = prev.filter((id) => id !== draggedId)
      const targetIndex = withoutDragged.indexOf(targetColumnId)
      if (targetIndex < 0) return prev
      const next = [...withoutDragged]
      next.splice(targetIndex, 0, draggedId)
      return next
    })
  }, [])

  const toggleOrderStatus = (statusId: number) => {
    setSelectedOrderStatusIds((prev) => {
      const exists = prev.includes(statusId)
      if (exists) {
        const next = prev.filter((id) => id !== statusId)
        setColumnOrder((currentOrder) => currentOrder.filter((id) => id !== statusId))
        return next
      }
      setColumnOrder((currentOrder) =>
        currentOrder.includes(statusId) ? currentOrder : [...currentOrder, statusId],
      )
      return [...prev, statusId]
    })
  }

  const toggleNoOrderStatusColumn = (checked: boolean) => {
    setShowNoOrderStatusColumn(checked)
    setColumnOrder((prev) => {
      if (checked) {
        return prev.includes(NO_ORDER_STATUS_COLUMN_ID)
          ? prev
          : [...prev, NO_ORDER_STATUS_COLUMN_ID]
      }
      return prev.filter((id) => id !== NO_ORDER_STATUS_COLUMN_ID)
    })
  }

  const totalShown = useMemo(
    () => boardColumns.reduce((sum, c) => sum + (columnData[c.id]?.total ?? 0), 0),
    [boardColumns, columnData],
  )
  const visibleBoardColumns = useMemo(() => {
    if (!search.trim()) return boardColumns

    return boardColumns.filter((column) => {
      const state = columnData[column.id]
      return state?.loading || (state?.total ?? 0) > 0
    })
  }, [boardColumns, columnData, search])
  const anyLoaded = useMemo(
    () => boardColumns.some((c) => columnData[c.id]?.loaded),
    [boardColumns, columnData],
  )
  const isEmpty = anyLoaded && totalShown === 0

  return (
    <Box>
      <Stack
        direction={{ xs: 'column', sm: 'row' }}
        spacing={2}
        alignItems={{ xs: 'stretch', sm: 'center' }}
        justifyContent="space-between"
        sx={{ mb: 3 }}
      >
        <Box>
          <Typography variant="h4" sx={{ fontWeight: 800 }}>
            Заказы
          </Typography>
          <Typography variant="body2" color="text.secondary">
            Колонки построены по статусам заказа. Перетаскивайте карточки между ними.
          </Typography>
        </Box>
        <Stack direction="row" spacing={1}>
          <Button
            variant="outlined"
            startIcon={<ViewWeekIcon />}
            onClick={() => setColumnsDialogOpen(true)}
          >
            Колонки статусов
          </Button>
        </Stack>
      </Stack>

      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2} sx={{ mb: 2 }}>
        <TextField
          placeholder="Поиск по номеру или названию"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          size="small"
          fullWidth
          InputProps={{
            startAdornment: (
              <InputAdornment position="start">
                <SearchIcon fontSize="small" />
              </InputAdornment>
            ),
          }}
        />
        <Badge color="primary" badgeContent={activePeopleFilterCount} overlap="rectangular">
          <Button
            variant="outlined"
            startIcon={<PeopleAltIcon />}
            onClick={() => setPeopleFilterOpen(true)}
            sx={{ whiteSpace: 'nowrap', minWidth: { xs: '100%', sm: 'auto' } }}
          >
            Фильтры по людям
          </Button>
        </Badge>
      </Stack>

      {error && (
        <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError(null)}>
          {error}
        </Alert>
      )}

      {bootError && (
        <Alert severity="error" sx={{ mb: 2 }}>
          {bootError}
        </Alert>
      )}

      <Paper
        variant="outlined"
        sx={{
          p: 1.5,
          borderRadius: 1.5,
          minHeight: 440,
          overflowX: 'auto',
          bgcolor: '#f7f9fc',
        }}
      >
        {!initialized ? (
          <Box sx={{ display: 'flex', justifyContent: 'center', py: 8 }}>
            <CircularProgress />
          </Box>
        ) : boardColumns.length === 0 ? (
          <Box sx={{ textAlign: 'center', py: 8 }}>
            <Typography color="text.secondary" sx={{ mb: 1 }}>
              Выберите хотя бы одну колонку для отображения доски.
            </Typography>
            <Button variant="outlined" onClick={() => setColumnsDialogOpen(true)}>
              Настроить колонки
            </Button>
          </Box>
        ) : (
          <Stack direction="row" spacing={1.5} alignItems="flex-start">
            {visibleBoardColumns.map((column) => (
              <BoardColumnView
                key={column.id}
                column={column}
                state={columnData[column.id] ?? EMPTY_COLUMN_STATE}
                isColumnDragging={draggingColumnId === column.id}
                movingOrderId={movingOrderId}
                onColumnDragStart={handleColumnDragStart}
                onColumnDrop={handleColumnDrop}
                onColumnDragEnd={handleColumnDragEnd}
                onOrderDrop={handleOrderDrop}
                onOpenOrder={handleOpenOrder}
                onOrderDragStart={handleOrderDragStart}
                onOrderDragEnd={handleOrderDragEnd}
                onNearBottom={handleColumnNearBottom}
              />
            ))}
          </Stack>
        )}
      </Paper>

      {initialized && (
        <Typography variant="body2" color="text.secondary" sx={{ mt: 1.5 }}>
          Всего заказов по колонкам: {totalShown}
          {isEmpty ? ' (ничего не найдено по текущим фильтрам)' : ''}
        </Typography>
      )}

      <Dialog
        open={peopleFilterOpen}
        onClose={() => setPeopleFilterOpen(false)}
        maxWidth="sm"
        fullWidth
      >
        <DialogTitle>Фильтры по людям</DialogTitle>
        <DialogContent dividers>
          <DialogContentText sx={{ mb: 2 }}>
            Заказы можно отфильтровать по менеджерам и художникам. Пустой фильтр —
            без ограничения.
          </DialogContentText>
          <Stack spacing={2} sx={{ mt: 1 }}>
            <Autocomplete
              multiple
              disableCloseOnSelect
              size="small"
              options={deliveryManagerOptions}
              value={selectedDeliveryManagers}
              onChange={(_, values) => setSelectedDeliveryManagers(values)}
              noOptionsText="Нет менеджеров"
              renderInput={(params) => (
                <TextField {...params} label="Менеджер ведения" placeholder="Все" />
              )}
            />
            <Autocomplete
              multiple
              disableCloseOnSelect
              size="small"
              options={onboardingManagerOptions}
              value={selectedOnboardingManagers}
              onChange={(_, values) => setSelectedOnboardingManagers(values)}
              noOptionsText="Нет менеджеров"
              renderInput={(params) => (
                <TextField {...params} label="Менеджер оформления" placeholder="Все" />
              )}
            />
            <Autocomplete
              multiple
              disableCloseOnSelect
              size="small"
              options={sketchDesignerOptions}
              value={selectedSketchDesigners}
              onChange={(_, values) => setSelectedSketchDesigners(values)}
              noOptionsText="Нет художников"
              renderInput={(params) => (
                <TextField {...params} label="Художник эскиза" placeholder="Все" />
              )}
            />
            <Autocomplete
              multiple
              disableCloseOnSelect
              size="small"
              options={revisionDesignerOptions}
              value={selectedRevisionDesigners}
              onChange={(_, values) => setSelectedRevisionDesigners(values)}
              noOptionsText="Нет художников"
              renderInput={(params) => (
                <TextField {...params} label="Художник правок" placeholder="Все" />
              )}
            />
            <Divider />
            <FormControlLabel
              control={
                <Checkbox
                  checked={disableDesignerFilterForSketch}
                  onChange={(e) => setDisableDesignerFilterForSketch(e.target.checked)}
                />
              }
              label={
                <Box>
                  <Typography variant="body2">
                    Не фильтровать по художникам в колонке «{SKETCH_STATUS_NAME}»
                  </Typography>
                  <Typography variant="caption" color="text.secondary">
                    В этой колонке заказы будут показаны независимо от выбранных
                    художников.
                  </Typography>
                </Box>
              }
            />
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button
            color="inherit"
            disabled={activePeopleFilterCount === 0}
            onClick={() => {
              setSelectedDeliveryManagers([])
              setSelectedOnboardingManagers([])
              setSelectedSketchDesigners([])
              setSelectedRevisionDesigners([])
            }}
          >
            Сбросить
          </Button>
          <Button variant="contained" onClick={() => setPeopleFilterOpen(false)}>
            Готово
          </Button>
        </DialogActions>
      </Dialog>

      <Dialog
        open={columnsDialogOpen}
        onClose={() => setColumnsDialogOpen(false)}
        maxWidth="sm"
        fullWidth
      >
        <DialogTitle>Колонки по статусам заказа</DialogTitle>
        <DialogContent dividers>
          <DialogContentText sx={{ mb: 2 }}>
            Выберите статусы заказа, которые должны быть колонками. Порядок меняется
            перетаскиванием колонок на доске.
          </DialogContentText>
          <Stack direction="row" spacing={1} sx={{ mb: 2 }}>
            <Button
              size="small"
              onClick={() => {
                const allIds = orderStatuses.map((status) => status.id)
                setSelectedOrderStatusIds(allIds)
                setShowNoOrderStatusColumn(true)
                setColumnOrder([...allIds, NO_ORDER_STATUS_COLUMN_ID])
              }}
            >
              Выбрать все
            </Button>
            <Button
              size="small"
              onClick={() => {
                setSelectedOrderStatusIds([])
                setShowNoOrderStatusColumn(false)
                setColumnOrder([])
              }}
            >
              Снять все
            </Button>
          </Stack>

          <List sx={{ py: 0 }}>
            <ListItemButton
              sx={{ borderRadius: 1 }}
              onClick={() => toggleNoOrderStatusColumn(!showNoOrderStatusColumn)}
            >
              <FormControlLabel
                control={<Checkbox checked={showNoOrderStatusColumn} />}
                onClick={(event) => event.preventDefault()}
                label={<ListItemText primary="Без статуса заказа" />}
              />
            </ListItemButton>
            {orderStatuses.map((status) => {
              const checked = selectedOrderStatusIds.includes(status.id)
              return (
                <ListItemButton
                  key={status.id}
                  onClick={() => toggleOrderStatus(status.id)}
                  sx={{ borderRadius: 1 }}
                >
                  <FormControlLabel
                    control={<Checkbox checked={checked} />}
                    onClick={(event) => event.preventDefault()}
                    label={<ListItemText primary={status.name} />}
                  />
                </ListItemButton>
              )
            })}
          </List>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setColumnsDialogOpen(false)}>Закрыть</Button>
        </DialogActions>
      </Dialog>
    </Box>
  )
}
