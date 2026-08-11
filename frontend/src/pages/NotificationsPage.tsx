import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Alert,
  Box,
  Button,
  Checkbox,
  CircularProgress,
  FormControlLabel,
  FormGroup,
  Paper,
  Stack,
  Typography,
} from '@mui/material'
import NotificationsActiveIcon from '@mui/icons-material/NotificationsActive'
import client from '../api/client'
import { describeApiError, logApiError } from '../api/errors'
import type { BluesalesStatusOption, NotificationSettings } from '../api/types'

export default function NotificationsPage() {
  const [statuses, setStatuses] = useState<BluesalesStatusOption[]>([])
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [savedOk, setSavedOk] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const [statusesRes, settingsRes] = await Promise.all([
        client.get<BluesalesStatusOption[]>('/orders/order-statuses'),
        client.get<NotificationSettings>('/notifications/settings'),
      ])
      setStatuses(statusesRes.data)
      setSelected(new Set(settingsRes.data.orderStatusIds))
    } catch (err) {
      logApiError('загрузка настроек уведомлений', err)
      setError(describeApiError(err, 'Не удалось загрузить настройки уведомлений'))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const orderedStatuses = useMemo(
    () => [...statuses].sort((a, b) => a.sortOrder - b.sortOrder || a.id - b.id),
    [statuses],
  )

  const toggle = (statusId: number) => {
    setSavedOk(false)
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(statusId)) next.delete(statusId)
      else next.add(statusId)
      return next
    })
  }

  const save = async () => {
    setSaving(true)
    setError(null)
    setSavedOk(false)
    try {
      const { data } = await client.put<NotificationSettings>('/notifications/settings', {
        orderStatusIds: Array.from(selected),
      })
      setSelected(new Set(data.orderStatusIds))
      setSavedOk(true)
    } catch (err) {
      logApiError('сохранение настроек уведомлений', err)
      setError(describeApiError(err, 'Не удалось сохранить настройки'))
    } finally {
      setSaving(false)
    }
  }

  if (loading) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', py: 8 }}>
        <CircularProgress />
      </Box>
    )
  }

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2, maxWidth: 720 }}>
      <Stack direction="row" spacing={1.5} alignItems="center">
        <NotificationsActiveIcon color="primary" />
        <Box>
          <Typography variant="h5" sx={{ fontWeight: 800 }}>
            Уведомления
          </Typography>
          <Typography variant="body2" color="text.secondary">
            Выберите статусы заказов, о которых нужно сообщать в колокольчике
          </Typography>
        </Box>
      </Stack>

      {error && <Alert severity="error">{error}</Alert>}
      {savedOk && <Alert severity="success">Настройки сохранены</Alert>}

      <Paper variant="outlined" sx={{ p: 2.5 }}>
        {orderedStatuses.length === 0 ? (
          <Typography color="text.secondary">Справочник статусов пока пуст</Typography>
        ) : (
          <FormGroup>
            {orderedStatuses.map((status) => (
              <FormControlLabel
                key={status.id}
                control={
                  <Checkbox
                    checked={selected.has(status.id)}
                    onChange={() => toggle(status.id)}
                  />
                }
                label={status.name}
              />
            ))}
          </FormGroup>
        )}

        <Box sx={{ mt: 2 }}>
          <Button variant="contained" onClick={() => void save()} disabled={saving}>
            {saving ? 'Сохранение…' : 'Сохранить'}
          </Button>
        </Box>
      </Paper>

      <Typography variant="body2" color="text.secondary">
        Уведомления по чатам включаются и выключаются тумблером в разделе «Чаты».
      </Typography>
    </Box>
  )
}
