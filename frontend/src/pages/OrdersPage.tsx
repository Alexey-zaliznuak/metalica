import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import {
  Alert,
  Badge,
  Box,
  Button,
  Chip,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  InputAdornment,
  MenuItem,
  Paper,
  Pagination,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material'
import AddIcon from '@mui/icons-material/Add'
import SearchIcon from '@mui/icons-material/Search'
import EditNoteIcon from '@mui/icons-material/EditNote'
import { useNavigate } from 'react-router-dom'
import client from '../api/client'
import type { Order, OrderStatus, PaginatedResponse } from '../api/types'
import {
  ORDER_STATUSES,
  ORDER_STATUS_COLORS,
  ORDER_STATUS_LABELS,
  formatLastActivity,
} from '../utils'

export default function OrdersPage() {
  const navigate = useNavigate()
  const [orders, setOrders] = useState<Order[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState<OrderStatus | ''>('')

  const PAGE_SIZE = 30
  const [page, setPage] = useState(1)
  const [totalPages, setTotalPages] = useState(1)
  const [total, setTotal] = useState(0)

  const [dialogOpen, setDialogOpen] = useState(false)
  const [newOrderNumber, setNewOrderNumber] = useState('')
  const [newTitle, setNewTitle] = useState('')
  const [creating, setCreating] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const fetchOrders = useCallback(
    async (q: string, status: OrderStatus | '', pageNum: number) => {
      setLoading(true)
      setError(null)
      try {
        const { data } = await client.get<PaginatedResponse<Order>>('/orders', {
          params: {
            q: q || undefined,
            status: status || undefined,
            page: pageNum,
            limit: PAGE_SIZE,
          },
        })
        setOrders(data.items)
        setTotalPages(data.totalPages)
        setTotal(data.total)
      } catch {
        setError('Не удалось загрузить заказы')
      } finally {
        setLoading(false)
      }
    },
    [],
  )

  // Reset to first page when filters change.
  useEffect(() => {
    setPage(1)
  }, [search, statusFilter])

  // Debounced fetch on search / filter / page change.
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => {
      fetchOrders(search, statusFilter, page)
    }, 300)
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
    }
  }, [search, statusFilter, page, fetchOrders])

  const handleCreate = async (e: FormEvent) => {
    e.preventDefault()
    setCreating(true)
    setCreateError(null)
    try {
      const { data } = await client.post<Order>('/orders', {
        orderNumber: newOrderNumber.trim(),
        title: newTitle.trim() || undefined,
      })
      setDialogOpen(false)
      setNewOrderNumber('')
      setNewTitle('')
      navigate(`/orders/${data.id}`)
    } catch {
      setCreateError('Не удалось создать заказ. Возможно, номер уже занят.')
    } finally {
      setCreating(false)
    }
  }

  const isEmpty = useMemo(
    () => !loading && orders.length === 0,
    [loading, orders.length],
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
            Список заказов, статусы и активность по правкам
          </Typography>
        </Box>
        <Button
          variant="contained"
          startIcon={<AddIcon />}
          onClick={() => setDialogOpen(true)}
        >
          Создать заказ
        </Button>
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
        <TextField
          select
          label="Статус"
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value as OrderStatus | '')}
          size="small"
          sx={{ minWidth: { sm: 200 } }}
        >
          <MenuItem value="">Все статусы</MenuItem>
          {ORDER_STATUSES.map((s) => (
            <MenuItem key={s} value={s}>
              {ORDER_STATUS_LABELS[s]}
            </MenuItem>
          ))}
        </TextField>
      </Stack>

      {error && (
        <Alert severity="error" sx={{ mb: 2 }}>
          {error}
        </Alert>
      )}

      <Paper variant="outlined" sx={{ borderRadius: 1.5, overflow: 'hidden' }}>
        <TableContainer>
          <Table>
            <TableHead>
              <TableRow>
                <TableCell>Номер</TableCell>
                <TableCell>Название</TableCell>
                <TableCell>Статус</TableCell>
                <TableCell align="center">Правки</TableCell>
                <TableCell>Последняя активность</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {loading && (
                <TableRow>
                  <TableCell colSpan={5} align="center" sx={{ py: 6 }}>
                    <CircularProgress />
                  </TableCell>
                </TableRow>
              )}
              {isEmpty && (
                <TableRow>
                  <TableCell colSpan={5} align="center" sx={{ py: 6 }}>
                    <Typography color="text.secondary">
                      Заказы не найдены
                    </Typography>
                  </TableCell>
                </TableRow>
              )}
              {!loading &&
                orders.map((order) => (
                  <TableRow
                    key={order.id}
                    hover
                    onClick={() => navigate(`/orders/${order.id}`)}
                    sx={{ cursor: 'pointer' }}
                  >
                    <TableCell sx={{ fontWeight: 600 }}>
                      {order.orderNumber}
                    </TableCell>
                    <TableCell>{order.title || '—'}</TableCell>
                    <TableCell>
                      <Chip
                        size="small"
                        label={ORDER_STATUS_LABELS[order.status]}
                        color={ORDER_STATUS_COLORS[order.status]}
                        variant="filled"
                      />
                    </TableCell>
                    <TableCell align="center">
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
                    </TableCell>
                    <TableCell>
                      <Typography variant="body2" color="text.secondary">
                        {formatLastActivity(order.lastMessageAt)}
                      </Typography>
                    </TableCell>
                  </TableRow>
                ))}
            </TableBody>
          </Table>
        </TableContainer>
      </Paper>

      {!loading && total > 0 && (
        <Stack
          direction={{ xs: 'column', sm: 'row' }}
          spacing={1}
          alignItems="center"
          justifyContent="space-between"
          sx={{ mt: 2 }}
        >
          <Typography variant="body2" color="text.secondary">
            Показано {orders.length} из {total}
          </Typography>
          {totalPages > 1 && (
            <Pagination
              count={totalPages}
              page={page}
              onChange={(_, value) => setPage(value)}
              color="primary"
              shape="rounded"
            />
          )}
        </Stack>
      )}

      <Dialog
        open={dialogOpen}
        onClose={() => !creating && setDialogOpen(false)}
        fullWidth
        maxWidth="sm"
      >
        <form onSubmit={handleCreate}>
          <DialogTitle>Новый заказ</DialogTitle>
          <DialogContent>
            <Stack spacing={2} sx={{ mt: 1 }}>
              {createError && <Alert severity="error">{createError}</Alert>}
              <TextField
                label="Номер заказа"
                value={newOrderNumber}
                onChange={(e) => setNewOrderNumber(e.target.value)}
                required
                fullWidth
                autoFocus
              />
              <TextField
                label="Название (необязательно)"
                value={newTitle}
                onChange={(e) => setNewTitle(e.target.value)}
                fullWidth
              />
            </Stack>
          </DialogContent>
          <DialogActions sx={{ px: 3, pb: 2 }}>
            <Button onClick={() => setDialogOpen(false)} disabled={creating}>
              Отмена
            </Button>
            <Button
              type="submit"
              variant="contained"
              disabled={creating || !newOrderNumber.trim()}
              startIcon={
                creating ? <CircularProgress size={18} color="inherit" /> : null
              }
            >
              Создать
            </Button>
          </DialogActions>
        </form>
      </Dialog>
    </Box>
  )
}
