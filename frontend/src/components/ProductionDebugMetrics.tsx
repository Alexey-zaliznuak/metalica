import { Fragment, useEffect, useState } from 'react'
import { Alert, Box, Button, Card, Chip, Collapse, IconButton, Link, Stack, Table, TableBody, TableCell, TableContainer, TableHead, TablePagination, TableRow, TextField, Typography } from '@mui/material'
import RefreshIcon from '@mui/icons-material/Refresh'
import KeyboardArrowDownIcon from '@mui/icons-material/KeyboardArrowDown'
import KeyboardArrowUpIcon from '@mui/icons-material/KeyboardArrowUp'
import { Link as RouterLink } from 'react-router-dom'
import client from '../api/client'
import { describeApiError } from '../api/errors'
import type { ProductionDebugMetrics as DebugMetrics } from '../api/dev-metrics'

const number = (value: number) => value.toLocaleString('ru-RU')
const time = (value: string) => new Date(value).toLocaleTimeString('ru-RU', { timeZone: 'Europe/Moscow', hour: '2-digit', minute: '2-digit', second: '2-digit' })
const sizes = ['30x40', '40x60', '60x80'] as const

function OrderRow({ row }: { row: DebugMetrics['rows'][number] }) {
  const [open, setOpen] = useState(false)
  return <Fragment>
    <TableRow hover>
      <TableCell padding="checkbox"><IconButton size="small" aria-label={`${open ? 'Скрыть' : 'Показать'} фото заказа ${row.orderNumber}`} aria-expanded={open} onClick={() => setOpen(!open)}>{open ? <KeyboardArrowUpIcon /> : <KeyboardArrowDownIcon />}</IconButton></TableCell>
      <TableCell><Link component={RouterLink} to={`/orders/${row.orderId}`} fontWeight={700}>№ {row.orderNumber}</Link><Typography variant="caption" color="text.secondary" display="block">ID {row.orderId}</Typography></TableCell>
      <TableCell align="right"><Typography fontWeight={800}>{number(row.newTasks)}</Typography></TableCell>
      <TableCell align="right"><Typography fontWeight={700}>{number(row.newPhotos)}</Typography>{row.newPhotos > 0 && <Chip size="small" variant="outlined" color={row.completePhotoSets === row.newPhotos ? 'success' : 'warning'} label={`${row.completePhotoSets} из ${row.newPhotos} × 3`} sx={{ mt: 0.5 }} />}</TableCell>
      <TableCell align="right" sx={{ whiteSpace: 'nowrap' }}>{sizes.map((size) => number(row.sizes[size])).join(' / ')}</TableCell>
      <TableCell align="right"><Typography fontWeight={700}>{number(row.changedTasks + row.retriedTasks)}</Typography><Typography variant="caption" color="text.secondary" display="block">Данные: {row.changedTasks} · Ошибка: {row.retriedTasks}</Typography></TableCell>
      <TableCell align="right" sx={{ whiteSpace: 'nowrap' }}>{time(row.lastCreatedAt)}</TableCell>
    </TableRow>
    <TableRow><TableCell colSpan={7} sx={{ py: 0, borderBottom: open ? undefined : 0 }}>
      <Collapse in={open} unmountOnExit>
        <Box sx={{ py: 2, pl: { xs: 0, md: 4 } }}>
          <Typography variant="subtitle2" mb={1}>Фото заказа № {row.orderNumber} — постановки за этот час</Typography>
          <Table size="small" aria-label={`Задачи по фото заказа ${row.orderNumber}`}>
            <TableHead><TableRow><TableCell>Фото ID</TableCell><TableCell align="right">Новых задач</TableCell>{sizes.map((size) => <TableCell align="right" key={size}>{size.replace('x', '×')}</TableCell>)}<TableCell align="right">Изменены данные</TableCell><TableCell align="right">Повтор после ошибки</TableCell></TableRow></TableHead>
            <TableBody>{row.photos.map((photo) => <TableRow key={photo.attachmentId}>
              <TableCell>#{photo.attachmentId}</TableCell><TableCell align="right">{photo.newTasks}</TableCell>{sizes.map((size) => <TableCell align="right" key={size}>{photo.sizes[size]}</TableCell>)}<TableCell align="right">{photo.changedTasks}</TableCell><TableCell align="right">{photo.retriedTasks}</TableCell>
            </TableRow>)}</TableBody>
          </Table>
        </Box>
      </Collapse>
    </TableCell></TableRow>
  </Fragment>
}

export default function ProductionDebugMetrics() {
  const [data, setData] = useState<DebugMetrics | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [refresh, setRefresh] = useState(0)
  const [query, setQuery] = useState('')
  const [page, setPage] = useState(0)

  useEffect(() => {
    let active = true
    let inFlight = false
    const controller = new AbortController()
    const load = async () => {
      if (inFlight || document.hidden) return
      inFlight = true
      setLoading(true)
      try {
        const response = await client.get<DebugMetrics>('/dev-metrics/production-debug', { signal: controller.signal })
        if (active) { setData(response.data); setError(null) }
      } catch (err) {
        if (active) setError(describeApiError(err, 'Не удалось загрузить дебаг производства'))
      } finally {
        inFlight = false
        if (active) setLoading(false)
      }
    }
    const onVisible = () => { if (!document.hidden) void load() }
    void load()
    const timer = window.setInterval(() => { void load() }, 10_000)
    document.addEventListener('visibilitychange', onVisible)
    return () => { active = false; controller.abort(); window.clearInterval(timer); document.removeEventListener('visibilitychange', onVisible) }
  }, [refresh])

  const filtered = (data?.rows ?? []).filter((row) => row.orderNumber.toLowerCase().includes(query.trim().toLowerCase()) || String(row.orderId).includes(query.trim()))
  const currentPage = Math.min(page, Math.max(0, Math.ceil(filtered.length / 25) - 1))
  return <Stack spacing={2.5}>
    <Stack direction={{ xs: 'column', sm: 'row' }} justifyContent="space-between" gap={2}>
      <Box><Typography variant="h6">Дебаг производства · последний час</Typography><Typography variant="body2" color="text.secondary">{data ? `${time(data.period.from)} — ${time(data.period.to)} МСК` : 'Загрузка часового окна…'} · Постановки задач по заказам</Typography></Box>
      <Button variant="outlined" startIcon={<RefreshIcon />} disabled={loading} onClick={() => setRefresh((value) => value + 1)}>{loading ? 'Обновление…' : 'Обновить'}</Button>
    </Stack>
    <Alert severity="info" icon={false}>На одно фото создаются 3 задачи: 30×40, 40×60 и 60×80. Например, 12 новых задач — полный набор для 4 фото. Число фото проверяется по их ID, а повторная подготовка считается отдельно.</Alert>
    {error && <Alert severity="error">{error}{data && ' Показаны данные последнего успешного обновления.'}</Alert>}
    {data && <>
      <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr 1fr', md: 'repeat(4, 1fr)' }, gap: 2 }}>
        {[
          ['Новых задач', data.totals.newTasks], ['Фото в новых задачах', data.totals.newPhotos],
          ['Повторных постановок', data.totals.changedTasks + data.totals.retriedTasks], ['Заказов за час', data.rows.length],
        ].map(([label, value]) => <Card key={label} sx={{ p: 2.5, boxShadow: 'none', border: '1px solid', borderColor: 'divider' }}><Typography variant="body2" color="text.secondary">{label}</Typography><Typography sx={{ fontSize: 30, fontWeight: 800, mt: 0.5 }}>{number(Number(value))}</Typography></Card>)}
      </Box>
      <Card sx={{ p: { xs: 1.5, md: 2.5 } }}>
        <TextField size="small" label="Номер или ID заказа" value={query} onChange={(event) => { setQuery(event.target.value); setPage(0) }} sx={{ mb: 2, width: { xs: '100%', sm: 300 } }} />
        <TableContainer><Table size="small" aria-label="Созданные задачи производства по заказам">
          <TableHead><TableRow><TableCell padding="checkbox" /><TableCell>Заказ</TableCell><TableCell align="right">Новых задач</TableCell><TableCell align="right">Фото<Typography variant="caption" display="block">в новых задачах</Typography></TableCell><TableCell align="right">30×40 / 40×60 / 60×80</TableCell><TableCell align="right">Повторно</TableCell><TableCell align="right">Последняя постановка, МСК</TableCell></TableRow></TableHead>
          <TableBody>{filtered.slice(currentPage * 25, (currentPage + 1) * 25).map((row) => <OrderRow key={row.orderId} row={row} />)}
            {!filtered.length && <TableRow><TableCell colSpan={7} sx={{ py: 5, textAlign: 'center', color: 'text.secondary' }}>{query.trim() ? 'Заказы не найдены.' : 'За последний час постановок задач не зарегистрировано.'}</TableCell></TableRow>}
          </TableBody>
        </Table></TableContainer>
        {filtered.length > 25 && <TablePagination component="div" count={filtered.length} page={currentPage} onPageChange={(_, value) => setPage(value)} rowsPerPage={25} rowsPerPageOptions={[25]} labelDisplayedRows={({ from, to, count }) => `${from}–${to} из ${count}`} />}
      </Card>
      <Typography variant="caption" color="text.secondary">Обновлено {time(data.generatedAt)} МСК · Автообновление каждые 10 секунд · Журнал хранится {data.retentionDays} дней. Учитываются события после установки этого обновления; прежние постановки не восстанавливаются.</Typography>
    </>}
    <Typography variant="body2" color="text.secondary">Раскройте заказ для проверки отдельных фото. Метка «4 из 4 × 3» означает, что для каждого из четырёх фото создано по одному заданию каждого размера. Неполный набор возможен на границе часового окна. «Повторно» включает изменение данных для печати и ручной перезапуск после ошибки; автоматические попытки обработки и чтение готового файла не создают новые задачи в журнале.</Typography>
  </Stack>
}
