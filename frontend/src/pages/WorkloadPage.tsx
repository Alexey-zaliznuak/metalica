import { useEffect, useMemo, useState } from 'react'
import {
  Alert,
  Box,
  CircularProgress,
  Paper,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  ToggleButton,
  ToggleButtonGroup,
  Typography,
} from '@mui/material'
import client from '../api/client'
import type { WorkloadMetric } from '../api/types'
import { roleLabel } from '../utils'

type WorkloadFilter = 'ALL' | 'MANAGER' | 'DESIGNER'

const FILTER_LABELS: Record<WorkloadFilter, string> = {
  ALL: 'Все',
  MANAGER: 'Менеджеры',
  DESIGNER: 'Дизайнеры',
}

export default function WorkloadPage() {
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState<WorkloadFilter>('ALL')
  const [items, setItems] = useState<WorkloadMetric[]>([])

  useEffect(() => {
    let active = true
    ;(async () => {
      setLoading(true)
      setError(null)
      try {
        const { data } = await client.get<WorkloadMetric[]>('/metrics/workload')
        if (!active) return
        setItems(data)
      } catch {
        if (active) {
          setError('Не удалось загрузить нагрузку пользователей')
        }
      } finally {
        if (active) {
          setLoading(false)
        }
      }
    })()
    return () => {
      active = false
    }
  }, [])

  const visibleItems = useMemo(() => {
    if (filter === 'ALL') return items
    return items.filter((item) => item.role === filter)
  }, [filter, items])

  const managersCount = useMemo(
    () => items.filter((item) => item.role === 'MANAGER').length,
    [items],
  )
  const designersCount = useMemo(
    () => items.filter((item) => item.role === 'DESIGNER').length,
    [items],
  )

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
          Нагрузка
        </Typography>
        <Typography variant="body2" color="text.secondary">
          Текущая загрузка менеджеров и дизайнеров по назначенным заказам
        </Typography>
      </Box>

      {error && (
        <Alert severity="error" sx={{ mb: 2 }}>
          {error}
        </Alert>
      )}

      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2} sx={{ mb: 2 }}>
        <ToggleButtonGroup
          value={filter}
          exclusive
          onChange={(_, value: WorkloadFilter | null) => {
            if (value) setFilter(value)
          }}
          size="small"
        >
          <ToggleButton value="ALL">{FILTER_LABELS.ALL}</ToggleButton>
          <ToggleButton value="MANAGER">
            {FILTER_LABELS.MANAGER} ({managersCount})
          </ToggleButton>
          <ToggleButton value="DESIGNER">
            {FILTER_LABELS.DESIGNER} ({designersCount})
          </ToggleButton>
        </ToggleButtonGroup>
      </Stack>

      <Paper variant="outlined" sx={{ borderRadius: 1.5, overflow: 'hidden' }}>
        <TableContainer>
          <Table>
            <TableHead>
              <TableRow>
                <TableCell sx={{ fontWeight: 700 }}>Пользователь</TableCell>
                <TableCell sx={{ fontWeight: 700 }}>Роль</TableCell>
                <TableCell sx={{ fontWeight: 700 }}>Нагрузка</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {visibleItems.length === 0 && (
                <TableRow>
                  <TableCell colSpan={3} align="center" sx={{ py: 4 }}>
                    <Typography color="text.secondary">Нет пользователей</Typography>
                  </TableCell>
                </TableRow>
              )}
              {visibleItems.map((item) => (
                <TableRow key={item.userId} hover>
                  <TableCell>
                    <Typography sx={{ fontWeight: 700 }}>{item.name}</Typography>
                    <Typography variant="caption" color="text.secondary">
                      @{item.username}
                    </Typography>
                  </TableCell>
                  <TableCell>{roleLabel(item.role)}</TableCell>
                  <TableCell>
                    {item.role === 'MANAGER' ? (
                      <Typography variant="body2">
                        Заказов на ведении: {item.deliveryOrders}, заказов на оформлении:{' '}
                        {item.onboardingOrders}
                      </Typography>
                    ) : (
                      <Typography variant="body2">
                        Заказов на эскизе: {item.sketchOrders}, заказов на правках:{' '}
                        {item.revisionOrders} (открытые по последнему сообщению:{' '}
                        {item.revisionOrdersWithOpenRequest})
                      </Typography>
                    )}
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
