import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  IconButton,
  Link,
  Paper,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Tooltip,
  Typography,
} from '@mui/material'
import ArrowBackIcon from '@mui/icons-material/ArrowBack'
import client from '../api/client'
import { describeApiError, logApiError } from '../api/errors'
import type { AssignmentJournalEntry, MessagesPage } from '../api/types'
import { directionLabel, formatDateTime } from '../utils'

const PAGE_SIZE = 50

type RoleFilter = 'all' | 'sketch' | 'revision'
type SourceFilter = 'all' | 'auto' | 'manual'

function fieldLabel(field: string): string {
  if (field === 'sketchDesigner') return 'Эскиз'
  if (field === 'revisionDesigner') return 'Правки'
  return field
}

export default function AssignmentJournalPage() {
  const navigate = useNavigate()
  const [items, setItems] = useState<AssignmentJournalEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [hasMore, setHasMore] = useState(false)
  const [nextCursor, setNextCursor] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [roleFilter, setRoleFilter] = useState<RoleFilter>('all')
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>('all')
  const [searchInput, setSearchInput] = useState('')
  const [search, setSearch] = useState('')
  const loadingMoreRef = useRef(false)

  const load = useCallback(
    async (before?: number) => {
      const { data } = await client.get<MessagesPage<AssignmentJournalEntry>>(
        '/assignment/journal',
        {
          params: {
            limit: PAGE_SIZE,
            before,
            role: roleFilter === 'all' ? undefined : roleFilter,
            source: sourceFilter === 'all' ? undefined : sourceFilter,
            q: search || undefined,
          },
        },
      )
      return data
    },
    [roleFilter, sourceFilter, search],
  )

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    void load()
      .then((data) => {
        if (cancelled) return
        setItems(data.items)
        setNextCursor(data.nextCursor)
        setHasMore(data.hasMore)
      })
      .catch((err) => {
        if (cancelled) return
        logApiError('загрузка журнала распределения', err)
        setError(describeApiError(err, 'Не удалось загрузить журнал распределения'))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [load])

  const loadMore = async () => {
    if (loadingMoreRef.current || !hasMore || nextCursor == null) return
    loadingMoreRef.current = true
    setLoadingMore(true)
    try {
      const data = await load(nextCursor)
      setItems((prev) => {
        const existing = new Set(prev.map((item) => item.id))
        return [...prev, ...data.items.filter((item) => !existing.has(item.id))]
      })
      setNextCursor(data.nextCursor)
      setHasMore(data.hasMore)
    } catch (err) {
      logApiError('подгрузка журнала распределения', err)
      setError(describeApiError(err, 'Не удалось загрузить следующие записи'))
    } finally {
      setLoadingMore(false)
      loadingMoreRef.current = false
    }
  }

  return (
    <Box>
      <Stack
        direction={{ xs: 'column', sm: 'row' }}
        spacing={2}
        alignItems={{ xs: 'stretch', sm: 'flex-start' }}
        justifyContent="space-between"
        sx={{ mb: 3 }}
      >
        <Stack direction="row" spacing={1.5} alignItems="center">
          <Tooltip title="К нагрузке">
            <IconButton onClick={() => navigate('/workload')} size="small">
              <ArrowBackIcon />
            </IconButton>
          </Tooltip>
          <Box>
            <Typography variant="h4" sx={{ fontWeight: 800 }}>
              Журнал распределения
            </Typography>
            <Typography variant="body2" color="text.secondary">
              Кому и когда отдали заказ: автораспределение и ручные назначения
            </Typography>
          </Box>
        </Stack>
      </Stack>

      {error && (
        <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError(null)}>
          {error}
        </Alert>
      )}

      <Stack
        direction={{ xs: 'column', md: 'row' }}
        spacing={1.5}
        sx={{ mb: 2 }}
        alignItems={{ md: 'center' }}
      >
        <ToggleButtonGroup
          value={roleFilter}
          exclusive
          size="small"
          onChange={(_, value: RoleFilter | null) => {
            if (value) setRoleFilter(value)
          }}
        >
          <ToggleButton value="all">Все роли</ToggleButton>
          <ToggleButton value="sketch">Эскизы</ToggleButton>
          <ToggleButton value="revision">Правки</ToggleButton>
        </ToggleButtonGroup>
        <ToggleButtonGroup
          value={sourceFilter}
          exclusive
          size="small"
          onChange={(_, value: SourceFilter | null) => {
            if (value) setSourceFilter(value)
          }}
        >
          <ToggleButton value="all">Все источники</ToggleButton>
          <ToggleButton value="auto">Авто</ToggleButton>
          <ToggleButton value="manual">Вручную</ToggleButton>
        </ToggleButtonGroup>
        <TextField
          size="small"
          placeholder="Номер заказа или имя художника"
          value={searchInput}
          onChange={(event) => setSearchInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') setSearch(searchInput.trim())
          }}
          sx={{ minWidth: { xs: '100%', md: 280 } }}
        />
        <Button
          variant="outlined"
          onClick={() => setSearch(searchInput.trim())}
          sx={{ alignSelf: { xs: 'stretch', md: 'center' } }}
        >
          Найти
        </Button>
      </Stack>

      <Paper variant="outlined" sx={{ borderRadius: 1.5, overflow: 'hidden' }}>
        {loading ? (
          <Box sx={{ display: 'flex', justifyContent: 'center', py: 8 }}>
            <CircularProgress />
          </Box>
        ) : (
          <TableContainer>
            <Table>
              <TableHead>
                <TableRow>
                  <TableCell sx={{ fontWeight: 700 }}>Когда</TableCell>
                  <TableCell sx={{ fontWeight: 700 }}>Заказ</TableCell>
                  <TableCell sx={{ fontWeight: 700 }}>Кому</TableCell>
                  <TableCell sx={{ fontWeight: 700 }}>Роль</TableCell>
                  <TableCell sx={{ fontWeight: 700 }}>Как</TableCell>
                  <TableCell sx={{ fontWeight: 700 }}>Кто назначил</TableCell>
                  <TableCell sx={{ fontWeight: 700 }}>Направление</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {items.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={7} align="center" sx={{ py: 4 }}>
                      <Typography color="text.secondary">
                        Пока нет записей о выдаче заказов
                      </Typography>
                    </TableCell>
                  </TableRow>
                ) : (
                  items.map((item) => (
                    <TableRow key={item.id} hover>
                      <TableCell sx={{ whiteSpace: 'nowrap' }}>
                        {formatDateTime(item.createdAt)}
                      </TableCell>
                      <TableCell>
                        <Link
                          component="button"
                          underline="hover"
                          onClick={() => navigate(`/orders/${item.order.id}`)}
                          sx={{ fontWeight: 700, textAlign: 'left' }}
                        >
                          {item.order.orderNumber}
                        </Link>
                        {item.order.title && (
                          <Typography variant="caption" color="text.secondary" display="block">
                            {item.order.title}
                          </Typography>
                        )}
                      </TableCell>
                      <TableCell>
                        <Typography sx={{ fontWeight: 700 }}>
                          {item.assignee.name ?? '—'}
                        </Typography>
                        {item.previousAssignee && (
                          <Typography variant="caption" color="text.secondary">
                            было: {item.previousAssignee}
                          </Typography>
                        )}
                      </TableCell>
                      <TableCell>{fieldLabel(item.field)}</TableCell>
                      <TableCell>
                        <Chip
                          size="small"
                          label={item.source === 'auto' ? 'Авто' : 'Вручную'}
                          color={item.source === 'auto' ? 'primary' : 'default'}
                          variant={item.source === 'auto' ? 'filled' : 'outlined'}
                        />
                      </TableCell>
                      <TableCell>
                        {item.source === 'auto'
                          ? 'Система'
                          : item.actor?.name ?? '—'}
                      </TableCell>
                      <TableCell>
                        {item.direction ? directionLabel(item.direction) : '—'}
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </TableContainer>
        )}
      </Paper>

      {hasMore && !loading && (
        <Box sx={{ display: 'flex', justifyContent: 'center', mt: 2 }}>
          <Button
            onClick={() => void loadMore()}
            disabled={loadingMore}
            startIcon={loadingMore ? <CircularProgress size={16} /> : undefined}
          >
            Загрузить ещё
          </Button>
        </Box>
      )}
    </Box>
  )
}
