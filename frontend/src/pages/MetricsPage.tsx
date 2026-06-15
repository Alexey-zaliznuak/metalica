import { useEffect, useState } from 'react'
import {
  Alert,
  Box,
  Card,
  CardContent,
  CircularProgress,
  Grid,
  Paper,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Typography,
} from '@mui/material'
import ShoppingCartIcon from '@mui/icons-material/ShoppingCart'
import EditNoteIcon from '@mui/icons-material/EditNote'
import TimerIcon from '@mui/icons-material/Timer'
import PendingActionsIcon from '@mui/icons-material/PendingActions'
import ReportProblemIcon from '@mui/icons-material/ReportProblem'
import type { ReactNode } from 'react'
import client from '../api/client'
import type { DesignerMetric, MetricsOverview } from '../api/types'
import { formatDuration } from '../utils'
import { BRAND, ACCENT } from '../theme'

function MetricCard({
  icon,
  label,
  value,
  color,
}: {
  icon: ReactNode
  label: string
  value: ReactNode
  color: string
}) {
  return (
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
              background: `linear-gradient(135deg, ${color}, ${color}cc)`,
              color: '#fff',
              boxShadow: `0 8px 18px ${color}44`,
              flexShrink: 0,
            }}
          >
            {icon}
          </Box>
          <Box>
            <Typography variant="h5" sx={{ fontWeight: 700, lineHeight: 1.2 }}>
              {value}
            </Typography>
            <Typography variant="body2" color="text.secondary">
              {label}
            </Typography>
          </Box>
        </Stack>
      </CardContent>
    </Card>
  )
}

export default function MetricsPage() {
  const [overview, setOverview] = useState<MetricsOverview | null>(null)
  const [byDesigner, setByDesigner] = useState<DesignerMetric[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    ;(async () => {
      setLoading(true)
      setError(null)
      try {
        const [overviewRes, designerRes] = await Promise.all([
          client.get<MetricsOverview>('/metrics/overview'),
          client.get<DesignerMetric[]>('/metrics/by-designer'),
        ])
        if (!active) return
        setOverview(overviewRes.data)
        setByDesigner(designerRes.data)
      } catch {
        if (active) setError('Не удалось загрузить метрики')
      } finally {
        if (active) setLoading(false)
      }
    })()
    return () => {
      active = false
    }
  }, [])

  if (loading) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', py: 8 }}>
        <CircularProgress />
      </Box>
    )
  }

  const maxRevisions = byDesigner.reduce(
    (max, d) => Math.max(max, d.revisions),
    0,
  )

  return (
    <Box>
      <Box sx={{ mb: 3 }}>
        <Typography variant="h4" sx={{ fontWeight: 800 }}>
          Метрики
        </Typography>
        <Typography variant="body2" color="text.secondary">
          Сводка по заказам, правкам и работе дизайнеров
        </Typography>
      </Box>

      {error && (
        <Alert severity="error" sx={{ mb: 2 }}>
          {error}
        </Alert>
      )}

      <Grid container spacing={2} sx={{ mb: 4 }}>
        <Grid item xs={12} sm={6} md={2.4}>
          <MetricCard
            icon={<ShoppingCartIcon />}
            label="всего заказов"
            value={overview?.totalOrders ?? 0}
            color={BRAND.deep}
          />
        </Grid>
        <Grid item xs={12} sm={6} md={2.4}>
          <MetricCard
            icon={<EditNoteIcon />}
            label="всего правок"
            value={overview?.totalRevisions ?? 0}
            color={BRAND.main}
          />
        </Grid>
        <Grid item xs={12} sm={6} md={2.4}>
          <MetricCard
            icon={<TimerIcon />}
            label="среднее время правки"
            value={formatDuration(overview?.avgRevisionSeconds)}
            color={BRAND.light}
          />
        </Grid>
        <Grid item xs={12} sm={6} md={2.4}>
          <MetricCard
            icon={<PendingActionsIcon />}
            label="открытых правок"
            value={overview?.openRevisions ?? 0}
            color={ACCENT.revision}
          />
        </Grid>
        <Grid item xs={12} sm={6} md={2.4}>
          <MetricCard
            icon={<ReportProblemIcon />}
            label="зависших правок"
            value={overview?.stuckRevisions ?? 0}
            color="#d32f2f"
          />
        </Grid>
      </Grid>

      <Typography variant="h6" sx={{ mb: 1.5 }}>
        По дизайнерам
      </Typography>
      <Paper variant="outlined" sx={{ borderRadius: 1.5, overflow: 'hidden' }}>
        <TableContainer>
          <Table>
            <TableHead>
              <TableRow>
                <TableCell sx={{ fontWeight: 700 }}>Имя</TableCell>
                <TableCell sx={{ fontWeight: 700 }}>Число правок</TableCell>
                <TableCell sx={{ fontWeight: 700 }}>Среднее время</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {byDesigner.length === 0 && (
                <TableRow>
                  <TableCell colSpan={3} align="center" sx={{ py: 4 }}>
                    <Typography color="text.secondary">Нет данных</Typography>
                  </TableCell>
                </TableRow>
              )}
              {byDesigner.map((d) => (
                <TableRow key={d.designerId} hover>
                  <TableCell sx={{ fontWeight: 600 }}>{d.name}</TableCell>
                  <TableCell>
                    <Stack
                      direction="row"
                      spacing={1}
                      alignItems="center"
                      sx={{ maxWidth: 320 }}
                    >
                      <Box
                        sx={{
                          flexGrow: 1,
                          height: 8,
                          borderRadius: 4,
                          bgcolor: `${BRAND.pale}`,
                          overflow: 'hidden',
                        }}
                      >
                        <Box
                          sx={{
                            height: '100%',
                            borderRadius: 4,
                            width: `${
                              maxRevisions > 0
                                ? (d.revisions / maxRevisions) * 100
                                : 0
                            }%`,
                            background: `linear-gradient(90deg, ${BRAND.deep}, ${BRAND.light})`,
                          }}
                        />
                      </Box>
                      <Typography variant="body2" sx={{ minWidth: 24 }}>
                        {d.revisions}
                      </Typography>
                    </Stack>
                  </TableCell>
                  <TableCell>{formatDuration(d.avgRevisionSeconds)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      </Paper>
    </Box>
  )
}
