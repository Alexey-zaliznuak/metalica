import { useEffect, useState } from 'react'
import { Alert, Box, Button, Card, Chip, CircularProgress, LinearProgress, Stack, Typography } from '@mui/material'
import RefreshIcon from '@mui/icons-material/Refresh'
import client from '../api/client'
import { describeApiError } from '../api/errors'
import type { ImageQueueMetrics as QueueMetrics, ImageQueueState } from '../api/dev-metrics'

const formatNumber = (value: number) => value.toLocaleString('ru-RU')
const dateTime = (value: string) => new Date(value).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })

function duration(seconds: number) {
  const rounded = Math.ceil(Math.max(0, seconds))
  if (rounded < 60) return `${rounded} с`
  if (rounded < 3600) return `${Math.ceil(rounded / 60)} мин`
  if (rounded < 86400) {
    const minutes = Math.ceil(rounded / 60)
    return `${Math.floor(minutes / 60)} ч ${minutes % 60} мин`
  }
  const hours = Math.ceil(rounded / 3600)
  return `${Math.floor(hours / 24)} д ${hours % 24} ч`
}

function etaText(seconds: number | null, outstanding: number) {
  if (!outstanding) return 'Очередь пуста'
  return seconds == null ? 'Мало данных' : `≈ ${duration(seconds)}`
}

function QueueChart({ data, kind }: { data: QueueMetrics; kind: 'production' | 'preview' }) {
  const waitingKey = kind === 'production' ? 'productionWaiting' : 'previewWaiting'
  const runningKey = kind === 'production' ? 'productionRunning' : 'previewRunning'
  const color = kind === 'production' ? '#1591dc' : '#6d5ce7'
  const end = new Date(data.sampledAt).getTime()
  const start = end - data.historyHours * 3_600_000
  const rows = data.history.filter((row) => {
    const at = new Date(row.sampledAt).getTime()
    return at >= start && at <= end
  })
  if (!rows.length) return <Alert severity="info">История начнёт появляться после первого замера очереди.</Alert>
  const max = rows.reduce((maximum, row) => Math.max(maximum, row[waitingKey], row[runningKey]), 4)
  const step = Math.max(1, Math.ceil(max / 4))
  const top = step * 4
  const x = (value: string) => 52 + (new Date(value).getTime() - start) / (end - start) * 640
  const y = (value: number) => 222 - value / top * 174
  const points = (key: typeof waitingKey | typeof runningKey) => rows.map((row, index) => {
    const current = `${x(row.sampledAt)},${y(row[key])}`
    return index ? `${x(row.sampledAt)},${y(rows[index - 1][key])} ${current}` : current
  }).join(' ')
  const last = rows[rows.length - 1]
  const axisTime = (timestamp: number) => new Date(timestamp).toLocaleString('ru-RU', {
    timeZone: 'Europe/Moscow', ...(data.historyHours > 24 ? { day: '2-digit', month: '2-digit' } : {}), hour: '2-digit', minute: '2-digit',
  })
  return <Box sx={{ overflowX: 'auto' }}>
    <Box component="svg" viewBox="0 0 740 276" role="img" aria-label={`История очереди ${kind === 'production' ? 'фото для производства' : 'превью'}: ожидающие и выполняемые задачи`} sx={{ width: '100%', minWidth: 410, display: 'block' }}>
      <text x={52} y={22} fill="#75869a" fontSize={11}>задач</text>
      {[0, 1, 2, 3, 4].map((tick) => <g key={tick}>
        <line x1={52} x2={692} y1={y(tick * step)} y2={y(tick * step)} stroke="#e5edf5" />
        <text x={42} y={y(tick * step) + 4} textAnchor="end" fill="#75869a" fontSize={11}>{formatNumber(tick * step)}</text>
      </g>)}
      <polyline points={points(waitingKey)} stroke={color} strokeWidth={2.5} fill="none" strokeLinejoin="round" />
      <polyline points={points(runningKey)} stroke="#149c88" strokeWidth={2} strokeDasharray="5 4" fill="none" />
      <circle cx={x(last.sampledAt)} cy={y(last[waitingKey])} r={4} fill={color} stroke="white" strokeWidth={1.5} />
      {[0, 1, 2, 3, 4].map((tick) => <text key={tick} x={52 + tick / 4 * 640} y={249} textAnchor={tick === 0 ? 'start' : tick === 4 ? 'end' : 'middle'} fill="#75869a" fontSize={11}>{axisTime(start + tick / 4 * (end - start))}</text>)}
    </Box>
  </Box>
}

function QueueCard({ title, state, slots, color, data, kind }: { title: string; state: ImageQueueState; slots: number; color: string; data: QueueMetrics; kind: 'production' | 'preview' }) {
  const outstanding = state.waiting + state.running
  return <Card sx={{ p: { xs: 2, md: 3 }, height: '100%' }}>
    <Stack direction="row" alignItems="center" justifyContent="space-between" gap={1} flexWrap="wrap" mb={2}>
      <Typography variant="h6">{title}</Typography>
      <Chip size="small" color={outstanding ? 'info' : 'success'} variant="outlined" label={outstanding ? `${formatNumber(outstanding)} задач` : 'Готово'} />
    </Stack>
    <Box sx={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 2, mb: 2 }}>
      <Box><Typography variant="body2" color="text.secondary">Ожидают</Typography><Typography sx={{ fontSize: 32, fontWeight: 800, color }}>{formatNumber(state.waiting)}</Typography></Box>
      <Box><Typography variant="body2" color="text.secondary">Обрабатываются</Typography><Typography sx={{ fontSize: 32, fontWeight: 800 }}>{formatNumber(state.running)}<Typography component="span" color="text.secondary" sx={{ fontSize: 16 }}> / {formatNumber(slots)}</Typography></Typography></Box>
    </Box>
    <LinearProgress variant="determinate" value={slots ? Math.min(100, state.running / slots * 100) : 0} sx={{ height: 5, borderRadius: 4, mb: 2, bgcolor: '#edf2f8', '& .MuiLinearProgress-bar': { bgcolor: color } }} />
    <Stack direction="row" gap={2} justifyContent="space-between" flexWrap="wrap" mb={2}>
      <Box><Typography variant="caption" color="text.secondary">До завершения текущих задач</Typography><Typography fontWeight={700}>{etaText(state.etaSeconds, outstanding)}</Typography></Box>
      <Box><Typography variant="caption" color="text.secondary">{kind === 'production' ? 'Готово вариантов за последний час' : 'Готово за последний час'}</Typography><Typography fontWeight={700}>{formatNumber(state.completedLastHour)}</Typography></Box>
    </Stack>
    <Stack direction="row" gap={2} flexWrap="wrap" mb={1}>
      <Typography variant="caption" sx={{ color }}>● Ожидают</Typography>
      <Typography variant="caption" sx={{ color: '#149c88' }}>┄ Обрабатываются</Typography>
    </Stack>
    <QueueChart data={data} kind={kind} />
    <Typography variant="body2" color="text.secondary">Средняя обработка: {state.averageDurationMs == null ? 'мало данных' : duration(state.averageDurationMs / 1000)} · Темп: {state.throughputPerMinute == null ? 'мало данных' : `${state.throughputPerMinute.toLocaleString('ru-RU', { maximumFractionDigits: 1 })} задач/мин`}</Typography>
    {kind === 'production' && <Typography variant="caption" color="text.secondary" display="block" mt={1}>Учитываются готовые варианты файлов из раздела «Фото для печати»: по 3 размера на фото, включая ранее прикреплённые фото и повторную подготовку при изменении шапки. Это не число новых загрузок.</Typography>}
    {state.unavailable > 0 && <Typography variant="caption" color="text.secondary" display="block" mt={1}>Превью не требуется / недоступно для формата: {formatNumber(state.unavailable)}. В ожидающую очередь не входит.</Typography>}
    {state.failed > 0 && <Alert severity="warning" sx={{ mt: 2 }}>Ошибок обработки: {formatNumber(state.failed)}. Эти задачи не входят в ожидающую очередь.</Alert>}
  </Card>
}

export default function ImageQueueMetrics() {
  const [hours, setHours] = useState(24)
  const [refresh, setRefresh] = useState(0)
  const [data, setData] = useState<QueueMetrics | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    let inFlight = false
    const controller = new AbortController()
    const load = async () => {
      if (inFlight || document.hidden) return
      inFlight = true
      setLoading(true)
      try {
        const response = await client.get<QueueMetrics>('/dev-metrics/image-queue', { params: { hours }, signal: controller.signal })
        if (active) { setData(response.data); setError(null) }
      } catch (err) {
        if (active) setError(describeApiError(err, 'Не удалось загрузить очередь изображений'))
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
  }, [hours, refresh])

  const outstanding = data ? data.production.waiting + data.production.running + data.preview.waiting + data.preview.running : 0
  return <Stack spacing={3}>
    <Stack direction={{ xs: 'column', sm: 'row' }} justifyContent="space-between" gap={2}>
      <Box><Typography fontWeight={700}>Фоновая генерация изображений</Typography><Typography variant="body2" color="text.secondary">Размер очереди и оценка времени до завершения</Typography></Box>
      <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
        {([{ hours: 1, label: '1 час' }, { hours: 6, label: '6 часов' }, { hours: 24, label: 'Сутки' }, { hours: 168, label: '7 дней' }]).map((option) => <Button key={option.hours} size="small" variant={hours === option.hours ? 'contained' : 'outlined'} onClick={() => { if (hours !== option.hours) { setData(null); setHours(option.hours) } }}>{option.label}</Button>)}
        <Button variant="outlined" startIcon={<RefreshIcon />} onClick={() => setRefresh((value) => value + 1)} disabled={loading}>Обновить</Button>
      </Stack>
    </Stack>
    {error && <Alert severity="error">{error}{data && ' Показаны данные последнего успешного обновления; они могут быть устаревшими.'}</Alert>}
    {!data && loading && <Box sx={{ py: 8, textAlign: 'center' }}><CircularProgress /></Box>}
    {data && <>
      <Card sx={{ p: { xs: 2, md: 3 }, border: '1px solid', borderColor: 'divider', boxShadow: 'none' }}>
        <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', sm: 'repeat(3, 1fr)' }, gap: 2 }}>
          <Box><Typography variant="body2" color="text.secondary">Всего ожидают</Typography><Typography sx={{ fontSize: 28, fontWeight: 800 }}>{formatNumber(data.production.waiting + data.preview.waiting)}</Typography></Box>
          <Box><Typography variant="body2" color="text.secondary">Общий пул обработки</Typography><Typography sx={{ fontSize: 28, fontWeight: 800 }}>{formatNumber(data.production.running + data.preview.running)} / {formatNumber(data.concurrency.total)}</Typography><Typography variant="caption" color="text.secondary">Общий предел для производства и превью</Typography></Box>
          <Box><Typography variant="body2" color="text.secondary">Когда очередь завершится</Typography><Typography sx={{ fontSize: 28, fontWeight: 800 }}>{etaText(data.etaSeconds, outstanding)}</Typography><Typography variant="caption" color="text.secondary">При текущем темпе и без новых задач</Typography></Box>
        </Box>
      </Card>
      <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', xl: '1fr 1fr' }, gap: 2 }}>
        <QueueCard title="Фото для производства" state={data.production} slots={data.concurrency.production} color="#1591dc" data={data} kind="production" />
        <QueueCard title="Превью" state={data.preview} slots={data.concurrency.preview} color="#6d5ce7" data={data} kind="preview" />
      </Box>
      <Alert severity="info" icon={false}>Прогноз приблизительный и предполагает, что новые задачи не поступают. Размер фото, выбранный размер для производства, ошибки и скачивания досрочно могут изменить время. При недостатке успешных замеров или остановке обработки оценка не рассчитывается.</Alert>
      <Typography variant="caption" color="text.secondary">Обновлено {dateTime(data.sampledAt)} МСК · Автообновление каждые 10 секунд · История хранится {data.retentionHours / 24} дней, замеры каждые {data.samplingIntervalSeconds} секунд. Длинные периоды показаны с сохранением пиков нагрузки. Лимиты, выполняемые задачи и темп относятся к текущему процессу сервера; ожидающие задачи учитывают сохранённую очередь.</Typography>
    </>}
  </Stack>
}
