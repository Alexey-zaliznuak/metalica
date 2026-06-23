import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
} from 'react'
import {
  Alert,
  Badge,
  Box,
  Button,
  Checkbox,
  Chip,
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
import { useNavigate } from 'react-router-dom'
import client, { USER_KEY } from '../api/client'
import { useAuth } from '../auth/AuthContext'
import type { BluesalesStatusOption, Order, OrdersBoardSettings, User } from '../api/types'
import { formatLastActivity } from '../utils'

const NO_ORDER_STATUS_COLUMN_ID = -1

const DEFAULT_BOARD_SETTINGS: OrdersBoardSettings = {
  selectedOrderStatusIds: [],
  columnOrder: [],
  searchQuery: '',
  showNoOrderStatusColumn: true,
}

interface BoardColumn {
  id: number
  name: string
  isNoOrderStatus: boolean
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

  return {
    selectedOrderStatusIds,
    columnOrder,
    searchQuery,
    showNoOrderStatusColumn,
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

export default function OrdersPage() {
  const { user } = useAuth()
  const navigate = useNavigate()
  const [orders, setOrders] = useState<Order[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [bootError, setBootError] = useState<string | null>(null)

  const [search, setSearch] = useState('')
  const [orderStatuses, setOrderStatuses] = useState<BluesalesStatusOption[]>([])
  const [selectedOrderStatusIds, setSelectedOrderStatusIds] = useState<number[]>([])
  const [showNoOrderStatusColumn, setShowNoOrderStatusColumn] = useState(true)
  const [columnOrder, setColumnOrder] = useState<number[]>([])
  const [draggingColumnId, setDraggingColumnId] = useState<number | null>(null)
  const [draggingOrderId, setDraggingOrderId] = useState<number | null>(null)
  const [movingOrderId, setMovingOrderId] = useState<number | null>(null)
  const [columnsDialogOpen, setColumnsDialogOpen] = useState(false)
  const [initialized, setInitialized] = useState(false)

  const [frontendSettingsBase, setFrontendSettingsBase] = useState<
    Record<string, unknown>
  >({})

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const fetchOrders = useCallback(async (q: string, statusIds: number[]) => {
    setLoading(true)
    setError(null)
    try {
      const { data } = await client.get<{ items: Order[] }>('/orders', {
        params: {
          q: q || undefined,
          orderStatusIds: statusIds.join(','),
        },
      })
      setOrders(data.items)
    } catch {
      setError('Не удалось загрузить заказы')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (!initialized) return
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => {
      fetchOrders(search, selectedOrderStatusIds)
    }, 300)
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
    }
  }, [search, selectedOrderStatusIds, initialized, fetchOrders])

  useEffect(() => {
    let active = true
    void client
      .get<BluesalesStatusOption[]>('/orders/order-statuses')
      .then((res) => {
        if (!active) return
        setOrderStatuses(res.data)

        const baseSettings = isRecord(user?.frontendSettings) ? user.frontendSettings : {}
        const parsed = parseBoardSettings(
          isRecord(baseSettings.ordersBoard) ? baseSettings.ordersBoard : undefined,
        )
        const allOrderStatusIds = res.data.map((status) => status.id)
        const normalized = normalizeColumns(
          allOrderStatusIds,
          parsed.selectedOrderStatusIds,
          parsed.columnOrder,
          parsed.showNoOrderStatusColumn,
        )

        setFrontendSettingsBase(baseSettings)
        setSearch(parsed.searchQuery)
        setShowNoOrderStatusColumn(parsed.showNoOrderStatusColumn)
        setSelectedOrderStatusIds(normalized.selectedIds)
        setColumnOrder(normalized.columnOrder)
        setInitialized(true)
      })
      .catch(() => {
        if (!active) return
        setBootError('Не удалось загрузить статусы заказов')
        setInitialized(true)
      })
    return () => {
      active = false
    }
  }, [user?.frontendSettings])

  useEffect(() => {
    if (!initialized) return
    const timeout = setTimeout(() => {
      const boardSettings: OrdersBoardSettings = {
        selectedOrderStatusIds,
        columnOrder,
        searchQuery: search,
        showNoOrderStatusColumn,
      }
      const frontendSettings = {
        ...frontendSettingsBase,
        ordersBoard: boardSettings,
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
    }, 600)
    return () => clearTimeout(timeout)
  }, [
    initialized,
    search,
    selectedOrderStatusIds,
    showNoOrderStatusColumn,
    columnOrder,
    frontendSettingsBase,
  ])

  const boardColumns = useMemo<BoardColumn[]>(() => {
    const byId = new Map(orderStatuses.map((status) => [status.id, status]))
    const allColumns = columnOrder
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
    return allColumns
  }, [orderStatuses, columnOrder, selectedOrderStatusIds])

  const ordersByColumn = useMemo(() => {
    const map = new Map<number, Order[]>()
    boardColumns.forEach((column) => map.set(column.id, []))
    for (const order of orders) {
      const columnId = order.orderStatusId ?? NO_ORDER_STATUS_COLUMN_ID
      if (map.has(columnId)) {
        map.get(columnId)!.push(order)
      }
    }
    return map
  }, [orders, boardColumns])

  const isEmpty = useMemo(() => !loading && orders.length === 0, [loading, orders.length])

  const orderStatusNameById = useMemo(() => {
    const map = new Map<number, string>()
    orderStatuses.forEach((status) => map.set(status.id, status.name))
    return map
  }, [orderStatuses])

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

  const handleColumnDrop = (targetColumnId: number) => {
    if (draggingColumnId == null || draggingColumnId === targetColumnId) return
    setColumnOrder((prev) => {
      const withoutDragged = prev.filter((id) => id !== draggingColumnId)
      const targetIndex = withoutDragged.indexOf(targetColumnId)
      if (targetIndex < 0) return prev
      const next = [...withoutDragged]
      next.splice(targetIndex, 0, draggingColumnId)
      return next
    })
  }

  const moveOrderToColumn = useCallback(
    async (orderId: number, targetColumnId: number) => {
      const current = orders.find((order) => order.id === orderId)
      if (!current) return

      const currentColumnId = current.orderStatusId ?? NO_ORDER_STATUS_COLUMN_ID
      if (currentColumnId === targetColumnId) return
      if (targetColumnId === NO_ORDER_STATUS_COLUMN_ID) return

      const nextOrderStatusId = targetColumnId
      const nextOrderStatus = orderStatusNameById.get(targetColumnId) ?? null

      const prevOrders = orders
      setMovingOrderId(orderId)
      setOrders((prev) =>
        prev.map((order) =>
          order.id === orderId
            ? {
                ...order,
                orderStatusId: nextOrderStatusId,
                orderStatus: nextOrderStatus,
              }
            : order,
        ),
      )

      try {
        const { data } = await client.patch<Order>(`/orders/${orderId}/order-status`, {
          statusId: nextOrderStatusId,
        })
        setOrders((prev) => prev.map((order) => (order.id === orderId ? data : order)))
      } catch {
        setOrders(prevOrders)
        setError(
          'Не удалось переместить заказ. Для ручных заказов статус в BlueSales не меняется.',
        )
      } finally {
        setMovingOrderId(null)
      }
    },
    [orderStatusNameById, orders],
  )

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
        {loading ? (
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
            {boardColumns.map((column) => {
              const columnOrders = ordersByColumn.get(column.id) ?? []
              return (
                <Paper
                  key={column.id}
                  variant="outlined"
                  draggable
                  onDragStart={() => setDraggingColumnId(column.id)}
                  onDragOver={(event: DragEvent<HTMLDivElement>) => event.preventDefault()}
                  onDrop={() => handleColumnDrop(column.id)}
                  onDragEnd={() => setDraggingColumnId(null)}
                  sx={{
                    width: 320,
                    flexShrink: 0,
                    borderRadius: 1.5,
                    borderColor:
                      draggingColumnId === column.id ? 'primary.main' : 'divider',
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
                    <Chip size="small" label={columnOrders.length} />
                  </Stack>
                  <Divider />
                  <Stack
                    spacing={1}
                    sx={{ p: 1, maxHeight: 560, overflowY: 'auto' }}
                    onDragOver={(event: DragEvent<HTMLDivElement>) => event.preventDefault()}
                    onDrop={() => {
                      if (draggingOrderId != null) {
                        void moveOrderToColumn(draggingOrderId, column.id)
                      }
                    }}
                  >
                    {columnOrders.length === 0 && (
                      <Typography
                        variant="body2"
                        color="text.secondary"
                        sx={{ textAlign: 'center', py: 3 }}
                      >
                        Нет заказов
                      </Typography>
                    )}
                    {columnOrders.map((order) => {
                      const canMoveCard = order.source === 'BLUESALES'
                      return (
                        <Paper
                          key={order.id}
                          variant="outlined"
                          draggable={canMoveCard}
                          onDragStart={() => {
                            if (canMoveCard) setDraggingOrderId(order.id)
                          }}
                          onDragEnd={() => setDraggingOrderId(null)}
                          onClick={() => navigate(`/orders/${order.id}`)}
                          sx={{
                            p: 1.2,
                            borderRadius: 1.3,
                            cursor: 'pointer',
                            opacity: movingOrderId === order.id ? 0.6 : 1,
                            '&:hover': { borderColor: 'primary.main', boxShadow: 1 },
                          }}
                        >
                          <Typography variant="subtitle2" sx={{ fontWeight: 700 }}>
                            {order.orderNumber}
                          </Typography>
                          <Typography
                            variant="body2"
                            color="text.secondary"
                            sx={{ mb: 1, minHeight: 20 }}
                          >
                            {order.title || 'Без названия'}
                          </Typography>
                          <Stack
                            direction="row"
                            spacing={1}
                            alignItems="center"
                            justifyContent="space-between"
                          >
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
                          <Stack
                            direction="row"
                            alignItems="center"
                            spacing={0.5}
                            sx={{ mt: 0.8 }}
                          >
                            <SyncAltIcon sx={{ fontSize: 12, color: 'text.secondary' }} />
                            <Typography variant="caption" color="text.secondary">
                              {canMoveCard
                                ? 'Можно перетаскивать'
                                : 'Ручной заказ: статус не переносится'}
                            </Typography>
                          </Stack>
                          <Typography variant="caption" color="text.secondary" sx={{ mt: 0.4 }}>
                            {formatLastActivity(order.lastMessageAt)}
                          </Typography>
                        </Paper>
                      )
                    })}
                  </Stack>
                </Paper>
              )
            })}
          </Stack>
        )}
      </Paper>

      {!loading && (
        <Typography variant="body2" color="text.secondary" sx={{ mt: 1.5 }}>
          Показано заказов: {orders.length}
          {isEmpty ? ' (ничего не найдено по текущим фильтрам)' : ''}
        </Typography>
      )}

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
