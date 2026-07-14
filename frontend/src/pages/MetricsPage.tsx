import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Alert,
  Box,
  Card,
  CardContent,
  CircularProgress,
  Grid,
  Stack,
  Typography,
} from '@mui/material'
import ShoppingCartIcon from '@mui/icons-material/ShoppingCart'
import EditNoteIcon from '@mui/icons-material/EditNote'
import BrushIcon from '@mui/icons-material/Brush'
import PendingActionsIcon from '@mui/icons-material/PendingActions'
import ReportProblemIcon from '@mui/icons-material/ReportProblem'
import type { ReactNode } from 'react'
import client from '../api/client'
import type { MetricsOverview } from '../api/types'
import { BRAND, ACCENT } from '../theme'

function MetricCard({
  icon,
  label,
  value,
  color,
  onClick,
}: {
  icon: ReactNode
  label: string
  value: ReactNode
  color: string
  onClick?: () => void
}) {
  return (
    <Card
      sx={{
        height: '100%',
        ...(onClick && {
          cursor: 'pointer',
          transition: 'transform 0.15s ease, box-shadow 0.15s ease',
          '&:hover': {
            transform: 'translateY(-2px)',
            boxShadow: 4,
          },
        }),
      }}
      onClick={onClick}
    >
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
  const navigate = useNavigate()
  const [overview, setOverview] = useState<MetricsOverview | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    ;(async () => {
      setLoading(true)
      setError(null)
      try {
        const overviewRes = await client.get<MetricsOverview>(
          '/metrics/overview',
        )
        if (!active) return
        setOverview(overviewRes.data)
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
            label="Правки"
            value={overview?.totalRevisions ?? 0}
            color={BRAND.main}
            onClick={() => navigate('/metrics/revisions')}
          />
        </Grid>
        <Grid item xs={12} sm={6} md={2.4}>
          <MetricCard
            icon={<BrushIcon />}
            label="Эскизы"
            value={overview?.totalSketches ?? 0}
            color={BRAND.light}
            onClick={() => navigate('/metrics/sketches')}
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
    </Box>
  )
}
