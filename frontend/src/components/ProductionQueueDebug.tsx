import { Fragment, useState } from 'react'
import { Alert, Box, Card, Chip, Collapse, IconButton, Link, Stack, Table, TableBody, TableCell, TableContainer, TableHead, TablePagination, TableRow, TextField, Typography } from '@mui/material'
import KeyboardArrowDownIcon from '@mui/icons-material/KeyboardArrowDown'
import KeyboardArrowUpIcon from '@mui/icons-material/KeyboardArrowUp'
import { Link as RouterLink } from 'react-router-dom'
import type { ProductionDebugMetrics, ProductionQueueTask } from '../api/dev-metrics'
import ProductionTaskDetails, { causeLabel } from './ProductionTaskDetails'

const dateTime = (value: string) => new Date(value).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
function TaskRow({ job }: { job: ProductionQueueTask }) {
  const [open, setOpen] = useState(false)
  return <Fragment>
    <TableRow hover>
      <TableCell padding="checkbox"><IconButton size="small" aria-expanded={open} aria-label={`${open ? 'Скрыть' : 'Показать'} причину задачи ${job.id}`} onClick={() => setOpen(!open)}>{open ? <KeyboardArrowUpIcon /> : <KeyboardArrowDownIcon />}</IconButton></TableCell>
      <TableCell><Link component={RouterLink} to={`/orders/${job.orderId}`}>№ {job.orderNumber}</Link><Typography variant="caption" display="block">ID {job.orderId}</Typography></TableCell>
      <TableCell>#{job.attachmentId}<Typography variant="caption" display="block">{job.textSize.replace('x', '×')} · задача {job.id}</Typography></TableCell>
      <TableCell>{job.leaseExpired ? 'Истёк срок обработки' : job.status === 'processing' ? 'Взята обработчиком' : job.error ? 'Ожидает повтора' : 'Ожидает'}</TableCell>
      <TableCell>{causeLabel(job.category)}</TableCell>
      <TableCell align="right">{job.attempts}</TableCell>
      <TableCell sx={{ whiteSpace: 'nowrap' }}>{job.queuedAt ? dateTime(job.queuedAt) : 'Не записано'}</TableCell>
    </TableRow>
    <TableRow><TableCell colSpan={7} sx={{ py: 0, borderBottom: open ? undefined : 0 }}><Collapse in={open} unmountOnExit><Stack spacing={1.5} sx={{ py: 2 }}>
      <ProductionTaskDetails cause={job.cause} trigger={job.trigger} changes={job.changes} />
      {job.error && <Alert severity="warning" sx={{ overflowWrap: 'anywhere' }}>Ошибка последней попытки: {job.error}</Alert>}
      <Typography variant="caption" color="text.secondary">Первая задача этого размера: {dateTime(job.createdAt)} МСК. {job.status === 'pending' && job.attempts > 0 ? `Повтор доступен с ${dateTime(job.nextAttemptAt)} МСК.` : ''} {job.leaseExpired ? 'Задача может быть повторно взята после завершения срока обработки.' : ''}</Typography>
    </Stack></Collapse></TableCell></TableRow>
  </Fragment>
}

export default function ProductionQueueDebug({ queue }: { queue: ProductionDebugMetrics['queue'] }) {
  const [cause, setCause] = useState('')
  const [query, setQuery] = useState('')
  const [page, setPage] = useState(0)
  const filtered = queue.rows.filter((row) => (!cause || row.category === cause) &&
    `${row.orderNumber} ${row.orderId} ${row.attachmentId}`.toLowerCase().includes(query.trim().toLowerCase()))
  const currentPage = Math.min(page, Math.max(0, Math.ceil(filtered.length / 25) - 1))
  return <Stack spacing={2}>
    <Box><Typography variant="h6">Из чего состоит очередь сейчас · {queue.total.toLocaleString('ru-RU')} задач</Typography>
      <Typography variant="body2" color="text.secondary">{queue.pending} ожидают · {queue.processing} взяты обработчиками · {queue.photos} фото · {queue.orders} заказов. Здесь все незавершённые задачи, независимо от времени постановки.</Typography></Box>
    <Stack direction="row" flexWrap="wrap" gap={1}>
      <Chip label={`Все: ${queue.total}`} color={!cause ? 'primary' : 'default'} onClick={() => { setCause(''); setPage(0) }} />
      {queue.causes.map((item) => <Chip key={item.cause} label={`${causeLabel(item.cause)}: ${item.count}`} color={cause === item.cause ? 'primary' : 'default'} onClick={() => { setCause(cause === item.cause ? '' : item.cause); setPage(0) }} />)}
    </Stack>
    {queue.causes.some((item) => item.cause === 'legacy_unknown') && <Alert severity="info">У части задач причина не сохранилась: они поставлены до запуска журнала. Такие задачи выделены отдельно, чтобы не считать их новыми фото или повторами без доказательств.</Alert>}
    <Card sx={{ p: { xs: 1.5, md: 2.5 } }}>
      <TextField label="Поиск в очереди: заказ или фото ID" size="small" value={query} onChange={(event) => { setQuery(event.target.value); setPage(0) }} sx={{ mb: 2, width: { xs: '100%', sm: 350 } }} />
      <TableContainer><Table size="small" aria-label="Причины задач в текущей очереди"><TableHead><TableRow>
        <TableCell padding="checkbox" /><TableCell>Заказ</TableCell><TableCell>Фото / размер</TableCell><TableCell>Состояние</TableCell><TableCell>Причина</TableCell><TableCell align="right">Попыток</TableCell><TableCell>Поставлена, МСК</TableCell>
      </TableRow></TableHead><TableBody>
        {filtered.slice(currentPage * 25, (currentPage + 1) * 25).map((job) => <TaskRow key={job.id} job={job} />)}
        {!filtered.length && <TableRow><TableCell colSpan={7} align="center" sx={{ py: 3 }}>{queue.total ? 'Задачи не найдены.' : 'Очередь пуста.'}</TableCell></TableRow>}
      </TableBody></Table></TableContainer>
      {filtered.length > 25 && <TablePagination component="div" count={filtered.length} page={currentPage} onPageChange={(_, value) => setPage(value)} rowsPerPage={25} rowsPerPageOptions={[25]} labelDisplayedRows={({ from, to, count }) => `${from}–${to} из ${count}`} />}
    </Card>
  </Stack>
}
