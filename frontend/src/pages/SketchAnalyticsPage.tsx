import { useCallback, useEffect, useState } from 'react'
import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  CircularProgress,
  Grid,
  IconButton,
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
  Tooltip,
  Typography,
} from '@mui/material'
import ArrowBackIcon from '@mui/icons-material/ArrowBack'
import TimerIcon from '@mui/icons-material/Timer'
import BrushIcon from '@mui/icons-material/Brush'
import PendingActionsIcon from '@mui/icons-material/PendingActions'
import { useNavigate } from 'react-router-dom'
import client from '../api/client'
import type { SketchAnalytics } from '../api/types'
import { formatDuration } from '../utils'
import { BRAND } from '../theme'

// Часовой пояс расчёта — Москва (UTC+3). Даты в БД в UTC.
const MSK_OFFSET_MINUTES = 180

const HOUR_OPTIONS = Array.from({ length: 25 }, (_, h) => h)

export default function SketchAnalyticsPage() {
  const navigate = useNavigate()
  const [workStartHour, setWorkStartHour] = useState(9)
  const [workEndHour, setWorkEndHour] = useState(21)
  const [data, setData] = useState<SketchAnalytics | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await client.get<SketchAnalytics>('/metrics/sketches/analytics', {
        params: {
          workStartHour,
          workEndHour,
          tzOffsetMinutes: MSK_OFFSET_MINUTES,
        },
      })
      setData(res.data)
    } catch {
      setError('Не удалось загрузить аналитику эскизов')
    } finally {
      setLoading(false)
    }
  }, [workStartHour, workEndHour])

  useEffect(() => {
    load()
  }, [load])

  const windowInvalid = workEndHour <= workStartHour
  const maxAvg = (data?.byDesigner ?? []).reduce(
    (max, d) => Math.max(max, d.avgWorkingSeconds ?? 0),
    0,
  )

  return (
    <Box>
      <Stack direction="row" spacing={1.5} alignItems="center" sx={{ mb: 3 }}>
        <Tooltip title="К метрикам">
          <IconButton onClick={() => navigate('/metrics')} size="small">
            <ArrowBackIcon />
          </IconButton>
        </Tooltip>
        <Box>
          <Typography variant="h4" sx={{ fontWeight: 800 }}>
            Аналитика эскизов
          </Typography>
          <Typography variant="body2" color="text.secondary">
            Среднее рабочее время изготовления эскиза по художникам (нерабочие часы вычитаются)
          </Typography>
        </Box>
      </Stack>

      <Paper variant="outlined" sx={{ p: 2, mb: 3, borderRadius: 1.5 }}>
        <Stack
          direction={{ xs: 'column', sm: 'row' }}
          spacing={2}
          alignItems={{ xs: 'stretch', sm: 'center' }}
        >
          <Typography variant="body2" sx={{ fontWeight: 600 }}>
            Рабочий день (МСК):
          </Typography>
          <TextField
            select
            size="small"
            label="Начало"
            value={workStartHour}
            onChange={(e) => setWorkStartHour(Number(e.target.value))}
            sx={{ minWidth: 120 }}
          >
            {HOUR_OPTIONS.map((h) => (
              <MenuItem key={h} value={h}>
                {String(h).padStart(2, '0')}:00
              </MenuItem>
            ))}
          </TextField>
          <TextField
            select
            size="small"
            label="Конец"
            value={workEndHour}
            onChange={(e) => setWorkEndHour(Number(e.target.value))}
            sx={{ minWidth: 120 }}
          >
            {HOUR_OPTIONS.map((h) => (
              <MenuItem key={h} value={h}>
                {String(h).padStart(2, '0')}:00
              </MenuItem>
            ))}
          </TextField>
          <Button variant="outlined" onClick={() => load()} disabled={windowInvalid}>
            Пересчитать
          </Button>
        </Stack>
        {windowInvalid && (
          <Alert severity="warning" sx={{ mt: 2 }}>
            Конец рабочего дня должен быть позже начала.
          </Alert>
        )}
      </Paper>

      {error && (
        <Alert severity="error" sx={{ mb: 2 }}>
          {error}
        </Alert>
      )}

      {loading ? (
        <Box sx={{ display: 'flex', justifyContent: 'center', py: 8 }}>
          <CircularProgress />
        </Box>
      ) : (
        <>
          <Grid container spacing={2} sx={{ mb: 4 }}>
            <Grid item xs={12} sm={6} md={4}>
              <Card sx={{ height: '100%' }}>
                <CardContent>
                  <Stack direction="row" spacing={2} alignItems="center">
                    <Box
                      sx={{
                        width: 52,
                        height: 52,
                        borderRadius: 1.5,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        background: `linear-gradient(135deg, ${BRAND.light}, ${BRAND.light}cc)`,
                        color: '#fff',
                        flexShrink: 0,
                      }}
                    >
                      <TimerIcon />
                    </Box>
                    <Box>
                      <Typography variant="h5" sx={{ fontWeight: 700, lineHeight: 1.2 }}>
                        {formatDuration(data?.overall.avgWorkingSeconds)}
                      </Typography>
                      <Typography variant="body2" color="text.secondary">
                        среднее рабочее время изготовления (по всем эскизам)
                      </Typography>
                    </Box>
                  </Stack>
                </CardContent>
              </Card>
            </Grid>
            <Grid item xs={12} sm={6} md={4}>
              <Card sx={{ height: '100%' }}>
                <CardContent>
                  <Stack direction="row" spacing={2} alignItems="center">
                    <Box
                      sx={{
                        width: 52,
                        height: 52,
                        borderRadius: 1.5,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        background: `linear-gradient(135deg, ${BRAND.main}, ${BRAND.main}cc)`,
                        color: '#fff',
                        flexShrink: 0,
                      }}
                    >
                      <BrushIcon />
                    </Box>
                    <Box>
                      <Typography variant="h5" sx={{ fontWeight: 700, lineHeight: 1.2 }}>
                        {data?.overall.count ?? 0}
                      </Typography>
                      <Typography variant="body2" color="text.secondary">
                        всего готовых эскизов
                      </Typography>
                    </Box>
                  </Stack>
                </CardContent>
              </Card>
            </Grid>
            <Grid item xs={12} sm={6} md={4}>
              <Card sx={{ height: '100%' }}>
                <CardContent>
                  <Stack direction="row" spacing={2} alignItems="center">
                    <Box
                      sx={{
                        width: 52,
                        height: 52,
                        borderRadius: 1.5,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        background: 'linear-gradient(135deg, #ed6c02, #ed6c02cc)',
                        color: '#fff',
                        flexShrink: 0,
                      }}
                    >
                      <PendingActionsIcon />
                    </Box>
                    <Box>
                      <Typography variant="h5" sx={{ fontWeight: 700, lineHeight: 1.2 }}>
                        {data?.inProgressCount ?? 0}
                      </Typography>
                      <Typography variant="body2" color="text.secondary">
                        эскизов в работе (начали, но не готовы)
                      </Typography>
                    </Box>
                  </Stack>
                </CardContent>
              </Card>
            </Grid>
          </Grid>

          <Typography variant="h6" sx={{ mb: 1.5 }}>
            По художникам эскиза
          </Typography>
          <Paper variant="outlined" sx={{ borderRadius: 1.5, overflow: 'hidden' }}>
            <TableContainer>
              <Table>
                <TableHead>
                  <TableRow>
                    <TableCell sx={{ fontWeight: 700 }}>Художник</TableCell>
                    <TableCell sx={{ fontWeight: 700 }}>Готовых эскизов</TableCell>
                    <TableCell sx={{ fontWeight: 700 }}>Среднее рабочее время</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {(data?.byDesigner.length ?? 0) === 0 && (
                    <TableRow>
                      <TableCell colSpan={3} align="center" sx={{ py: 4 }}>
                        <Typography color="text.secondary">Нет данных</Typography>
                      </TableCell>
                    </TableRow>
                  )}
                  {data?.byDesigner.map((d) => (
                    <TableRow key={d.designerId} hover>
                      <TableCell sx={{ fontWeight: 600 }}>{d.name}</TableCell>
                      <TableCell>{d.count}</TableCell>
                      <TableCell>
                        <Stack
                          direction="row"
                          spacing={1}
                          alignItems="center"
                          sx={{ maxWidth: 360 }}
                        >
                          <Box
                            sx={{
                              flexGrow: 1,
                              height: 8,
                              borderRadius: 4,
                              bgcolor: BRAND.pale,
                              overflow: 'hidden',
                            }}
                          >
                            <Box
                              sx={{
                                height: '100%',
                                borderRadius: 4,
                                width: `${
                                  maxAvg > 0
                                    ? ((d.avgWorkingSeconds ?? 0) / maxAvg) * 100
                                    : 0
                                }%`,
                                background: `linear-gradient(90deg, ${BRAND.deep}, ${BRAND.light})`,
                              }}
                            />
                          </Box>
                          <Typography variant="body2" sx={{ minWidth: 88 }}>
                            {formatDuration(d.avgWorkingSeconds)}
                          </Typography>
                        </Stack>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </TableContainer>
          </Paper>
        </>
      )}
    </Box>
  )
}
