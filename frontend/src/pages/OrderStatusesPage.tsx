import { useCallback, useEffect, useMemo, useState, type DragEvent } from 'react'
import {
  Alert,
  Box,
  Button,
  CircularProgress,
  IconButton,
  List,
  ListItem,
  ListItemText,
  Paper,
  Stack,
  Tooltip,
  Typography,
} from '@mui/material'
import ArrowDownwardIcon from '@mui/icons-material/ArrowDownward'
import ArrowUpwardIcon from '@mui/icons-material/ArrowUpward'
import DragIndicatorIcon from '@mui/icons-material/DragIndicator'
import SaveIcon from '@mui/icons-material/Save'
import client from '../api/client'
import type { BluesalesStatusOption } from '../api/types'

function idsOf(statuses: BluesalesStatusOption[]) {
  return statuses.map((status) => status.id)
}

export default function OrderStatusesPage() {
  const [statuses, setStatuses] = useState<BluesalesStatusOption[]>([])
  const [savedIds, setSavedIds] = useState<number[]>([])
  const [draggedId, setDraggedId] = useState<number | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState(false)

  const fetchStatuses = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const { data } =
        await client.get<BluesalesStatusOption[]>('/orders/order-statuses')
      setStatuses(data)
      setSavedIds(idsOf(data))
    } catch {
      setError('Не удалось загрузить статусы заказов')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchStatuses()
  }, [fetchStatuses])

  const hasChanges = useMemo(
    () =>
      statuses.length === savedIds.length &&
      statuses.some((status, index) => status.id !== savedIds[index]),
    [savedIds, statuses],
  )

  const moveStatus = (fromIndex: number, toIndex: number) => {
    if (
      fromIndex === toIndex ||
      fromIndex < 0 ||
      toIndex < 0 ||
      fromIndex >= statuses.length ||
      toIndex >= statuses.length
    ) {
      return
    }

    setSuccess(false)
    setStatuses((current) => {
      const next = [...current]
      const [moved] = next.splice(fromIndex, 1)
      next.splice(toIndex, 0, moved)
      return next.map((status, index) => ({ ...status, sortOrder: index }))
    })
  }

  const handleDrop = (event: DragEvent<HTMLLIElement>, targetIndex: number) => {
    event.preventDefault()
    const fromIndex = statuses.findIndex((status) => status.id === draggedId)
    moveStatus(fromIndex, targetIndex)
    setDraggedId(null)
  }

  const saveOrder = async () => {
    setSaving(true)
    setError(null)
    setSuccess(false)
    try {
      const { data } = await client.patch<BluesalesStatusOption[]>(
        '/orders/order-statuses/order',
        { orderedIds: idsOf(statuses) },
      )
      setStatuses(data)
      setSavedIds(idsOf(data))
      setSuccess(true)
    } catch {
      setError(
        'Не удалось сохранить порядок. Обновите страницу и попробуйте снова.',
      )
    } finally {
      setSaving(false)
    }
  }

  return (
    <Box>
      <Stack
        direction={{ xs: 'column', sm: 'row' }}
        spacing={2}
        alignItems={{ xs: 'stretch', sm: 'center' }}
        justifyContent="space-between"
        sx={{ mb: 3 }}
      >
        <Box>
          <Typography variant="h4" sx={{ fontWeight: 800 }}>
            Статусы заказов
          </Typography>
          <Typography variant="body2" color="text.secondary">
            Перетащите статус или используйте стрелки. Верхние статусы
            показываются первыми.
          </Typography>
        </Box>
        <Button
          variant="contained"
          startIcon={
            saving ? <CircularProgress size={18} color="inherit" /> : <SaveIcon />
          }
          disabled={!hasChanges || saving}
          onClick={saveOrder}
        >
          Сохранить порядок
        </Button>
      </Stack>

      {error && (
        <Alert severity="error" sx={{ mb: 2 }}>
          {error}
        </Alert>
      )}
      {success && (
        <Alert severity="success" sx={{ mb: 2 }}>
          Порядок статусов сохранён
        </Alert>
      )}
      {hasChanges && !success && (
        <Alert severity="info" sx={{ mb: 2 }}>
          Есть несохранённые изменения
        </Alert>
      )}

      <Paper variant="outlined" sx={{ borderRadius: 1.5, overflow: 'hidden' }}>
        {loading ? (
          <Stack alignItems="center" sx={{ py: 6 }}>
            <CircularProgress />
          </Stack>
        ) : statuses.length === 0 ? (
          <Typography color="text.secondary" align="center" sx={{ py: 6 }}>
            Статусы пока не найдены
          </Typography>
        ) : (
          <List disablePadding>
            {statuses.map((status, index) => (
              <ListItem
                key={status.id}
                divider={index < statuses.length - 1}
                draggable={!saving}
                onDragStart={() => setDraggedId(status.id)}
                onDragEnd={() => setDraggedId(null)}
                onDragOver={(event) => event.preventDefault()}
                onDrop={(event) => handleDrop(event, index)}
                sx={{
                  gap: 1,
                  bgcolor:
                    draggedId === status.id ? 'action.selected' : 'background.paper',
                  cursor: saving ? 'default' : 'grab',
                  '&:active': { cursor: saving ? 'default' : 'grabbing' },
                }}
              >
                <DragIndicatorIcon color="disabled" />
                <Typography
                  color="text.secondary"
                  sx={{ width: 32, textAlign: 'right', flexShrink: 0 }}
                >
                  {index + 1}
                </Typography>
                <ListItemText primary={status.name} secondary={`ID: ${status.id}`} />
                <Stack direction="row">
                  <Tooltip title="Поднять выше">
                    <span>
                      <IconButton
                        aria-label={`Поднять статус «${status.name}» выше`}
                        disabled={index === 0 || saving}
                        onClick={() => moveStatus(index, index - 1)}
                      >
                        <ArrowUpwardIcon />
                      </IconButton>
                    </span>
                  </Tooltip>
                  <Tooltip title="Опустить ниже">
                    <span>
                      <IconButton
                        aria-label={`Опустить статус «${status.name}» ниже`}
                        disabled={index === statuses.length - 1 || saving}
                        onClick={() => moveStatus(index, index + 1)}
                      >
                        <ArrowDownwardIcon />
                      </IconButton>
                    </span>
                  </Tooltip>
                </Stack>
              </ListItem>
            ))}
          </List>
        )}
      </Paper>
    </Box>
  )
}
