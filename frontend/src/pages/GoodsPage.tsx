import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Alert,
  Box,
  Chip,
  CircularProgress,
  MenuItem,
  Paper,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  TextField,
  Typography,
} from '@mui/material'
import client from '../api/client'
import { describeApiError, logApiError } from '../api/errors'
import type { GoodsItem, OrderDirection } from '../api/types'
import { ASSIGNABLE_DIRECTIONS, directionLabel } from '../utils'

const NOT_AFFECTING = 'NONE'

export default function GoodsPage() {
  const [goods, setGoods] = useState<GoodsItem[]>([])
  const [search, setSearch] = useState('')
  const [loading, setLoading] = useState(true)
  const [savingId, setSavingId] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)

  const fetchGoods = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const { data } = await client.get<GoodsItem[]>('/goods')
      setGoods(data)
    } catch (err) {
      logApiError('загрузка справочника товаров', err)
      setError(describeApiError(err, 'Не удалось загрузить справочник товаров'))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchGoods()
  }, [fetchGoods])

  const visible = useMemo(() => {
    const query = search.trim().toLowerCase()
    if (!query) return goods
    return goods.filter(
      (item) =>
        item.name.toLowerCase().includes(query) ||
        (item.marking ?? '').toLowerCase().includes(query),
    )
  }, [goods, search])

  const affectingCount = useMemo(
    () => goods.filter((item) => item.direction !== null).length,
    [goods],
  )

  const saveDirection = async (item: GoodsItem, direction: OrderDirection | null) => {
    setSavingId(item.id)
    setError(null)
    try {
      const { data } = await client.patch<GoodsItem>(`/goods/${item.id}`, {
        direction,
      })
      setGoods((current) =>
        current.map((row) => (row.id === data.id ? data : row)),
      )
    } catch (err) {
      logApiError(`сохранение типа заказа для товара «${item.name}»`, err)
      setError(
        describeApiError(err, `Не удалось сохранить тип заказа для «${item.name}»`),
      )
    } finally {
      setSavingId(null)
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
        <Box>
          <Typography variant="h4" sx={{ fontWeight: 800 }}>
            Товары
          </Typography>
          <Typography variant="body2" color="text.secondary">
            Справочник пополняется из заказов BlueSales. Тип заказа задают только
            те товары, которым он здесь назначен: остальные считаются допами и на
            распределение не влияют. Если у заказа нашлось несколько разных типов
            или ни одного, художника назначают вручную.
          </Typography>
        </Box>
        <TextField
          size="small"
          placeholder="Поиск по названию или артикулу"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          sx={{ minWidth: { sm: 280 } }}
        />
      </Stack>

      {error && (
        <Alert severity="error" sx={{ mb: 2 }}>
          {error}
        </Alert>
      )}

      {!loading && goods.length > 0 && (
        <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
          Влияют на тип заказа: {affectingCount} из {goods.length}
        </Typography>
      )}

      <Paper variant="outlined" sx={{ borderRadius: 1.5, overflow: 'hidden' }}>
        <TableContainer>
          <Table>
            <TableHead>
              <TableRow>
                <TableCell>Наименование</TableCell>
                <TableCell sx={{ display: { xs: 'none', md: 'table-cell' } }}>
                  Артикул
                </TableCell>
                <TableCell sx={{ width: 260 }}>Тип заказа</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {loading && (
                <TableRow>
                  <TableCell colSpan={3} align="center" sx={{ py: 6 }}>
                    <CircularProgress />
                  </TableCell>
                </TableRow>
              )}
              {!loading && visible.length === 0 && (
                <TableRow>
                  <TableCell colSpan={3} align="center" sx={{ py: 6 }}>
                    <Typography color="text.secondary">
                      {goods.length === 0
                        ? 'Товары появятся здесь после синхронизации заказов с BlueSales'
                        : 'Ничего не найдено'}
                    </Typography>
                  </TableCell>
                </TableRow>
              )}
              {!loading &&
                visible.map((item) => (
                  <TableRow key={item.id} hover>
                    <TableCell sx={{ fontWeight: 600 }}>
                      <Stack
                        direction="row"
                        spacing={1}
                        alignItems="center"
                        flexWrap="wrap"
                        useFlexGap
                      >
                        <span>{item.name}</span>
                        {item.direction && (
                          <Chip
                            size="small"
                            color="primary"
                            label={directionLabel(item.direction)}
                          />
                        )}
                      </Stack>
                    </TableCell>
                    <TableCell sx={{ display: { xs: 'none', md: 'table-cell' } }}>
                      <Typography variant="body2" color="text.secondary">
                        {item.marking ?? '—'}
                      </Typography>
                    </TableCell>
                    <TableCell>
                      <TextField
                        select
                        size="small"
                        fullWidth
                        value={item.direction ?? NOT_AFFECTING}
                        disabled={savingId === item.id}
                        onChange={(event) => {
                          const next = event.target.value
                          void saveDirection(
                            item,
                            next === NOT_AFFECTING
                              ? null
                              : (next as OrderDirection),
                          )
                        }}
                      >
                        <MenuItem value={NOT_AFFECTING}>Не влияет</MenuItem>
                        {ASSIGNABLE_DIRECTIONS.map((direction) => (
                          <MenuItem key={direction.value} value={direction.value}>
                            {direction.label}
                          </MenuItem>
                        ))}
                      </TextField>
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
