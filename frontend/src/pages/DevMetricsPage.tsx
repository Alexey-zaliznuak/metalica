import { useEffect, useState } from 'react'
import { Alert, Box, Button, Card, Chip, CircularProgress, IconButton, LinearProgress, Stack, Table, TableBody, TableCell, TableContainer, TableHead, TableRow, TextField, Typography } from '@mui/material'
import RefreshIcon from '@mui/icons-material/Refresh'
import ShieldOutlinedIcon from '@mui/icons-material/ShieldOutlined'
import AccessTimeIcon from '@mui/icons-material/AccessTime'
import ChevronLeftIcon from '@mui/icons-material/ChevronLeft'
import ChevronRightIcon from '@mui/icons-material/ChevronRight'
import client from '../api/client'
import { describeApiError } from '../api/errors'
import type { DevMetrics } from '../api/dev-metrics'

const HOUR = 3_600_000
const colors = ['#1591dc', '#6d5ce7', '#149c88', '#ed8b23', '#d15788', '#657b97']
const number = (value: number) => value.toLocaleString('ru-RU')
function duration(ms: number) {
  if (ms < 1000) return `${Math.round(ms)} мс`
  if (ms < 60_000) return `${(ms / 1000).toLocaleString('ru-RU', { maximumFractionDigits: 1 })} с`
  const seconds = Math.floor(ms / 1000)
  return `${Math.floor(seconds / 60)} мин ${seconds % 60} с`
}
const time = (date: string) => new Date(date).toLocaleTimeString('ru-RU', { timeZone: 'Europe/Moscow', hour: '2-digit', minute: '2-digit' })
const dateTime = (date: string) => new Date(date).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
const currentDate = () => new Date(Math.floor((Date.now() + 2 * HOUR) / (24 * HOUR)) * (24 * HOUR) + HOUR).toISOString().slice(0, 10)

function UsageChart({ data }: { data: DevMetrics }) {
  const start = new Date(data.period.start).getTime()
  const now = Math.min(new Date(data.generatedAt).getTime(), start + 24 * HOUR)
  const top = Math.max(60, data.summary.totalMs / 60_000, (data.forecast.projectedTotalMs ?? 0) / 60_000) * 1.15
  const x = (timestamp: number) => 52 + (timestamp - start) / (24 * HOUR) * 880
  const y = (ms: number) => 252 - (ms / 60_000) / top * 216
  const actual = [{ timestamp: start, ms: 0 }, ...data.hourly
    .filter((row) => new Date(row.at).getTime() < now)
    .map((row) => ({ timestamp: Math.min(new Date(row.at).getTime() + HOUR, now), ms: row.cumulativeMs }))]
  const actualPoints = actual.map((p) => `${x(p.timestamp)},${y(p.ms)}`).join(' ')
  const forecastPoints = data.forecast.points.map((p) => `${x(new Date(p.at).getTime())},${y(p.totalMs)}`).join(' ')
  return (
    <Box sx={{ overflowX: 'auto' }}>
      <Box component="svg" viewBox="0 0 970 300" role="img" aria-label="Накопленное время успешных запросов и прогноз до конца суток" sx={{ width: '100%', minWidth: 620, display: 'block' }}>
        <defs><linearGradient id="usage-area" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#1591dc" stopOpacity="0.2" /><stop offset="100%" stopColor="#1591dc" stopOpacity="0.01" /></linearGradient></defs>
        <rect x={52} y={26} width={880 * 5 / 24} height={226} fill="#f1f4f8" rx={6} />
        <text x={65} y={44} fill="#75869a" fontSize={11}>Пауза синков</text>
        {[0, 0.25, 0.5, 0.75, 1].map((fraction) => <g key={fraction}>
          <line x1={52} x2={932} y1={y(top * fraction * 60_000)} y2={y(top * fraction * 60_000)} stroke="#e5edf5" />
          <text x={42} y={y(top * fraction * 60_000) + 4} textAnchor="end" fill="#75869a" fontSize={11}>{Math.round(top * fraction)}</text>
        </g>)}
        <text x={15} y={17} fill="#75869a" fontSize={11}>мин</text>
        <line x1={52} x2={932} y1={y(HOUR)} y2={y(HOUR)} stroke="#e89b34" strokeDasharray="5 5" />
        <text x={929} y={y(HOUR) - 7} textAnchor="end" fill="#bc7620" fontSize={11}>Ориентир · 60 минут</text>
        <polygon points={`52,252 ${actualPoints} ${x(now)},252`} fill="url(#usage-area)" />
        <polyline points={actualPoints} stroke="#1591dc" strokeWidth={3} fill="none" strokeLinejoin="round" />
        {forecastPoints && <polyline points={forecastPoints} stroke="#8a77d8" strokeWidth={2.5} strokeDasharray="7 5" fill="none" />}
        <circle cx={x(now)} cy={y(data.summary.totalMs)} r={5} fill="#1591dc" stroke="white" strokeWidth={2} />
        {[0, 5, 8, 11, 14, 17, 20, 24].map((hour) => <text key={hour} x={x(start + hour * HOUR)} y={278} textAnchor="middle" fill="#75869a" fontSize={11}>{String((hour + 1) % 24).padStart(2, '0')}:00</text>)}
      </Box>
    </Box>
  )
}

function Stat({ title, value, detail }: { title: string; value: string; detail: string }) {
  return <Card sx={{ p: 2.5, height: '100%', boxShadow: 'none', border: '1px solid', borderColor: 'divider' }}>
    <Typography variant="body2" color="text.secondary">{title}</Typography>
    <Typography sx={{ fontSize: { xs: 24, md: 28 }, fontWeight: 800, letterSpacing: '-0.04em', my: 1 }}>{value}</Typography>
    <Typography variant="caption" color="text.secondary">{detail}</Typography>
  </Card>
}

export default function DevMetricsPage() {
  const [date, setDate] = useState('')
  const [refresh, setRefresh] = useState(0)
  const [data, setData] = useState<DevMetrics | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    let inFlight = false
    const controller = new AbortController()
    const load = async () => {
      if (inFlight) return
      inFlight = true
      setLoading(true)
      try {
        const res = await client.get<DevMetrics>('/dev-metrics', { params: date ? { date } : {}, signal: controller.signal })
        if (active) { setData(res.data); setError(null) }
      } catch (err) {
        if (active) setError(describeApiError(err, 'Не удалось загрузить аналитику BlueSales'))
      } finally {
        inFlight = false
        if (active) setLoading(false)
      }
    }
    void load()
    const timer = window.setInterval(() => { if (!document.hidden) void load() }, 30_000)
    return () => { active = false; controller.abort(); window.clearInterval(timer) }
  }, [date, refresh])

  const chooseDate = (value: string) => { if (value !== date) { setData(null); setDate(value) } }
  const selectedDate = date || data?.period.date || currentDate()
  const shiftDate = (days: number) => chooseDate(new Date(new Date(`${selectedDate}T12:00:00Z`).getTime() + days * 24 * HOUR).toISOString().slice(0, 10))
  const forecast = data?.forecast
  const forecastValue = forecast?.status === 'reached' ? 'Час уже набран'
    : forecast?.status === 'will-reach' && forecast.reachesAt ? `≈ ${time(forecast.reachesAt)} МСК`
      : forecast?.status === 'below-target' ? 'Не достигнем'
        : forecast?.status === 'closed' ? 'Период завершён' : 'Мало данных'
  const forecastDetail = forecast?.projectedTotalMs != null
    ? `Ожидается ${duration(forecast.projectedTotalMs)} к 01:00`
    : forecast?.status === 'closed' ? 'Показаны фактические итоги суток'
      : forecast?.status === 'reached' ? 'Суммарно набрано не менее 60 минут'
        : 'Нужно ≥ 15 минут наблюдения и ≥ 5 успешных запросов'

  return <Stack spacing={3}>
    <Box sx={{ background: 'linear-gradient(115deg, #132d50, #235c94)', borderRadius: 3, p: { xs: 3, md: 4 }, color: '#fff', position: 'relative', overflow: 'hidden' }}>
      <Stack direction="row" justifyContent="space-between" alignItems="center" gap={2} flexWrap="wrap">
        <Box>
          <Stack direction="row" alignItems="center" spacing={1} mb={1}><AccessTimeIcon sx={{ color: '#83c9ff' }} /><Typography variant="overline" sx={{ letterSpacing: 2, color: '#b7d9f5' }}>BlueSales / API usage</Typography></Stack>
          <Typography variant="h4" sx={{ color: '#fff' }}>Время под контролем</Typography>
          <Typography variant="body2" sx={{ mt: 1, color: '#c2d8ec' }}>Успешные запросы, расход по меткам и прогноз на сутки.</Typography>
        </Box>
        <Chip icon={<ShieldOutlinedIcon />} label="Только администраторы" sx={{ color: '#daebfa', bgcolor: '#ffffff12', '& .MuiChip-icon': { color: '#a1d1f6' } }} />
      </Stack>
    </Box>

    <Stack direction={{ xs: 'column', sm: 'row' }} alignItems={{ xs: 'stretch', sm: 'center' }} justifyContent="space-between" gap={2}>
      <Box><Typography fontWeight={700}>Сутки с 01:00 до 01:00 · Москва</Typography><Typography variant="body2" color="text.secondary">{data ? `${dateTime(data.period.start)} — ${dateTime(data.period.end)}` : 'Выберите период для просмотра'}</Typography></Box>
      <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
        <IconButton aria-label="Предыдущий период" onClick={() => shiftDate(-1)}><ChevronLeftIcon /></IconButton>
        <TextField type="date" label="Начало периода" size="small" value={selectedDate} onChange={(event) => chooseDate(event.target.value)} InputLabelProps={{ shrink: true }} inputProps={{ max: currentDate(), 'aria-label': 'Дата начала периода' }} />
        <IconButton aria-label="Следующий период" disabled={selectedDate >= currentDate()} onClick={() => shiftDate(1)}><ChevronRightIcon /></IconButton>
        <Button onClick={() => chooseDate('')} disabled={!date}>Текущий</Button>
        <Button variant="outlined" startIcon={<RefreshIcon />} onClick={() => setRefresh((value) => value + 1)} disabled={loading}>Обновить</Button>
      </Stack>
    </Stack>
    {error && <Alert severity="error">{error}{data && ' Показаны данные последнего успешного обновления.'}</Alert>}
    {!data && loading && <Box sx={{ py: 8, textAlign: 'center' }}><CircularProgress /></Box>}
    {data && <>
      <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr', lg: 'repeat(4, 1fr)' }, gap: 2 }}>
        <Stat title="Использовано за сутки" value={duration(data.summary.totalMs)} detail={`${(data.summary.totalMs / HOUR * 100).toFixed(1)}% от одного часа`} />
        <Stat title="Осталось до часа" value={duration(data.summary.remainingMs)} detail="Сумма времени успешных запросов" />
        <Stat title="Успешные запросы" value={number(data.summary.count)} detail={`Средний запрос · ${duration(data.summary.averageMs)}`} />
        <Stat title="Когда достигнем часа" value={forecastValue} detail={forecastDetail} />
      </Box>
      <Card sx={{ p: { xs: 2, md: 3 } }}>
        <Stack direction="row" alignItems="center" justifyContent="space-between" gap={1} flexWrap="wrap" mb={2}>
          <Box><Typography variant="h6">Накопленное время</Typography><Typography variant="body2" color="text.secondary">Как расходуется час в течение суток</Typography></Box>
          <Stack direction="row" spacing={2}><Typography variant="caption" sx={{ color: '#1591dc' }}>● Факт</Typography><Typography variant="caption" sx={{ color: '#8a77d8' }}>┄ Прогноз</Typography></Stack>
        </Stack>
        <UsageChart data={data} />
        <Alert severity="info" icon={false} sx={{ mt: 1 }}>Прогноз приблизительный: темп за последний час, пауза 01:00–06:00 и замедление синков втрое в 06:00–09:00 и 00:00–01:00. Изменение нагрузки и ручные действия могут сдвинуть время.</Alert>
      </Card>
      <Card sx={{ p: { xs: 2, md: 3 } }}>
        <Typography variant="h6">На что уходит время</Typography>
        <Typography variant="body2" color="text.secondary" mb={2}>Все успешные запросы по меткам, от самого затратного</Typography>
        {data.labels.length === 0 ? <Alert severity="info">В этом периоде успешные запросы ещё не зарегистрированы.</Alert> :
          <TableContainer><Table size="small" aria-label="Время запросов по меткам"><TableHead><TableRow>
            <TableCell>Метка запроса</TableCell><TableCell align="right">Время</TableCell><TableCell align="right">Доля</TableCell><TableCell align="right">Запросы</TableCell><TableCell align="right">Среднее</TableCell><TableCell align="right">Максимум</TableCell>
          </TableRow></TableHead><TableBody>{data.labels.map((row, index) => <TableRow key={row.label} hover>
            <TableCell sx={{ minWidth: 240, py: 2 }}><Typography sx={{ fontFamily: 'monospace', fontSize: 13, overflowWrap: 'anywhere', mb: 1 }}>{row.label}</Typography><LinearProgress variant="determinate" value={data.summary.totalMs ? row.durationMs / data.summary.totalMs * 100 : 0} sx={{ height: 5, borderRadius: 4, bgcolor: '#edf2f8', '& .MuiLinearProgress-bar': { bgcolor: colors[index % colors.length], borderRadius: 4 } }} /></TableCell>
            <TableCell align="right" sx={{ whiteSpace: 'nowrap', fontWeight: 700 }}>{duration(row.durationMs)}</TableCell>
            <TableCell align="right">{data.summary.totalMs ? (row.durationMs / data.summary.totalMs * 100).toFixed(1) : 0}%</TableCell>
            <TableCell align="right">{number(row.count)}</TableCell><TableCell align="right" sx={{ whiteSpace: 'nowrap' }}>{duration(row.averageMs)}</TableCell><TableCell align="right" sx={{ whiteSpace: 'nowrap' }}>{duration(row.maxMs)}</TableCell>
          </TableRow>)}</TableBody></Table></TableContainer>}
      </Card>
      {data.history.length > 0 && <Box>
        <Typography variant="h6" mb={1.5}>Последние периоды</Typography>
        <Stack direction="row" flexWrap="wrap" gap={1}>{data.history.map((period) => <Button key={period.date} variant={period.date === data.period.date ? 'contained' : 'outlined'} onClick={() => chooseDate(period.date)} sx={{ px: 2, py: 1 }}>
          {period.date.slice(8)}.{period.date.slice(5, 7)} · {duration(period.durationMs)}
        </Button>)}</Stack>
      </Box>}
      <Typography variant="caption" color="text.secondary">
        Обновлено {dateTime(data.generatedAt)} МСК · Автообновление каждые 30 секунд.
        {' '}Учитывается получение успешного ответа, без очереди, пауз и неудачных попыток. Запрос относится к суткам по времени начала.
        {data.trackingSince ? ` Учёт ведётся с ${dateTime(data.trackingSince)} МСК; более ранние запросы не восстановлены.` : 'Учёт начнётся с первого успешного запроса после обновления сервера.'}
      </Typography>
    </>}
  </Stack>
}
