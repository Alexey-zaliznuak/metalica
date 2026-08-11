import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Alert,
  Autocomplete,
  Box,
  Button,
  Checkbox,
  CircularProgress,
  FormControlLabel,
  Grid,
  Paper,
  Stack,
  TextField,
  Typography,
} from '@mui/material'
import NotificationsActiveIcon from '@mui/icons-material/NotificationsActive'
import client from '../api/client'
import { describeApiError, logApiError } from '../api/errors'
import type {
  BluesalesStatusOption,
  NotificationSettings,
  NotificationStatusSetting,
  OrderAssigneesResponse,
  OrderFilterOptions,
} from '../api/types'

type StatusPref = {
  enabled: boolean
  deliveryManagerNames: string[]
  onboardingManagerNames: string[]
  sketchDesignerNames: string[]
  revisionDesignerNames: string[]
}

const EMPTY_FILTERS = {
  deliveryManagerNames: [] as string[],
  onboardingManagerNames: [] as string[],
  sketchDesignerNames: [] as string[],
  revisionDesignerNames: [] as string[],
}

function emptyPref(): StatusPref {
  return { enabled: true, ...EMPTY_FILTERS }
}

export default function NotificationsPage() {
  const [statuses, setStatuses] = useState<BluesalesStatusOption[]>([])
  const [prefs, setPrefs] = useState<Record<number, StatusPref>>({})
  const [deliveryManagerOptions, setDeliveryManagerOptions] = useState<string[]>([])
  const [onboardingManagerOptions, setOnboardingManagerOptions] = useState<string[]>([])
  const [sketchDesignerOptions, setSketchDesignerOptions] = useState<string[]>([])
  const [revisionDesignerOptions, setRevisionDesignerOptions] = useState<string[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [savedOk, setSavedOk] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const [statusesRes, settingsRes, filterRes, assigneesRes] = await Promise.all([
        client.get<BluesalesStatusOption[]>('/orders/order-statuses'),
        client.get<NotificationSettings>('/notifications/settings'),
        client.get<OrderFilterOptions>('/orders/filter-options'),
        client.get<OrderAssigneesResponse>('/orders/assignees'),
      ])
      setStatuses(statusesRes.data)
      setDeliveryManagerOptions(filterRes.data.deliveryManagers)
      setOnboardingManagerOptions(filterRes.data.onboardingManagers)
      setSketchDesignerOptions(
        Array.from(
          new Set(assigneesRes.data.sketchDesigners.map((user) => user.name)),
        ).sort((a, b) => a.localeCompare(b, 'ru')),
      )
      setRevisionDesignerOptions(
        Array.from(
          new Set(assigneesRes.data.revisionDesigners.map((user) => user.name)),
        ).sort((a, b) => a.localeCompare(b, 'ru')),
      )

      const next: Record<number, StatusPref> = {}
      for (const row of settingsRes.data.statuses ?? []) {
        next[row.statusId] = {
          enabled: true,
          deliveryManagerNames: row.deliveryManagerNames ?? [],
          onboardingManagerNames: row.onboardingManagerNames ?? [],
          sketchDesignerNames: row.sketchDesignerNames ?? [],
          revisionDesignerNames: row.revisionDesignerNames ?? [],
        }
      }
      if (!settingsRes.data.statuses && settingsRes.data.orderStatusIds) {
        for (const statusId of settingsRes.data.orderStatusIds) {
          next[statusId] = emptyPref()
        }
      }
      setPrefs(next)
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

  const toggleEnabled = (statusId: number) => {
    setSavedOk(false)
    setPrefs((prev) => {
      const current = prev[statusId]
      if (current?.enabled) {
        const next = { ...prev }
        delete next[statusId]
        return next
      }
      return { ...prev, [statusId]: emptyPref() }
    })
  }

  const patchFilters = (
    statusId: number,
    patch: Partial<Omit<StatusPref, 'enabled'>>,
  ) => {
    setSavedOk(false)
    setPrefs((prev) => {
      const current = prev[statusId]
      if (!current?.enabled) return prev
      return { ...prev, [statusId]: { ...current, ...patch } }
    })
  }

  const save = async () => {
    setSaving(true)
    setError(null)
    setSavedOk(false)
    try {
      const statusesPayload: NotificationStatusSetting[] = Object.entries(prefs)
        .filter(([, pref]) => pref.enabled)
        .map(([statusId, pref]) => ({
          statusId: Number(statusId),
          deliveryManagerNames: pref.deliveryManagerNames,
          onboardingManagerNames: pref.onboardingManagerNames,
          sketchDesignerNames: pref.sketchDesignerNames,
          revisionDesignerNames: pref.revisionDesignerNames,
        }))
      const { data } = await client.put<NotificationSettings>('/notifications/settings', {
        statuses: statusesPayload,
      })
      const next: Record<number, StatusPref> = {}
      for (const row of data.statuses ?? []) {
        next[row.statusId] = {
          enabled: true,
          deliveryManagerNames: row.deliveryManagerNames ?? [],
          onboardingManagerNames: row.onboardingManagerNames ?? [],
          sketchDesignerNames: row.sketchDesignerNames ?? [],
          revisionDesignerNames: row.revisionDesignerNames ?? [],
        }
      }
      setPrefs(next)
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
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2, width: '100%' }}>
      <Stack direction="row" spacing={1.5} alignItems="center">
        <NotificationsActiveIcon color="primary" />
        <Box>
          <Typography variant="h5" sx={{ fontWeight: 800 }}>
            Уведомления
          </Typography>
          <Typography variant="body2" color="text.secondary">
            Выберите статусы и при необходимости ограничьте их фильтрами по людям
          </Typography>
        </Box>
      </Stack>

      {error && <Alert severity="error">{error}</Alert>}
      {savedOk && <Alert severity="success">Настройки сохранены</Alert>}

      <Paper variant="outlined" sx={{ p: 2.5, width: '100%' }}>
        {orderedStatuses.length === 0 ? (
          <Typography color="text.secondary">Справочник статусов пока пуст</Typography>
        ) : (
          <Stack spacing={2} sx={{ width: '100%' }}>
            {orderedStatuses.map((status) => {
              const pref = prefs[status.id]
              const enabled = Boolean(pref?.enabled)
              return (
                <Box
                  key={status.id}
                  sx={{
                    p: 1.5,
                    width: '100%',
                    boxSizing: 'border-box',
                    borderRadius: 1.5,
                    border: '1px solid',
                    borderColor: enabled ? 'divider' : 'transparent',
                    bgcolor: enabled ? 'action.hover' : 'transparent',
                  }}
                >
                  <FormControlLabel
                    sx={{ width: '100%', m: 0 }}
                    control={
                      <Checkbox
                        checked={enabled}
                        onChange={() => toggleEnabled(status.id)}
                      />
                    }
                    label={<Typography sx={{ fontWeight: 600 }}>{status.name}</Typography>}
                  />
                  {enabled && pref && (
                    <Grid container spacing={1.5} sx={{ mt: 0.5 }}>
                      <Grid item xs={12} md={6}>
                        <Autocomplete
                          multiple
                          disableCloseOnSelect
                          size="small"
                          fullWidth
                          options={deliveryManagerOptions}
                          value={pref.deliveryManagerNames}
                          onChange={(_, values) =>
                            patchFilters(status.id, { deliveryManagerNames: values })
                          }
                          noOptionsText="Нет менеджеров"
                          renderInput={(params) => (
                            <TextField
                              {...params}
                              label="Менеджер ведения"
                              placeholder="Все"
                            />
                          )}
                        />
                      </Grid>
                      <Grid item xs={12} md={6}>
                        <Autocomplete
                          multiple
                          disableCloseOnSelect
                          size="small"
                          fullWidth
                          options={onboardingManagerOptions}
                          value={pref.onboardingManagerNames}
                          onChange={(_, values) =>
                            patchFilters(status.id, { onboardingManagerNames: values })
                          }
                          noOptionsText="Нет менеджеров"
                          renderInput={(params) => (
                            <TextField
                              {...params}
                              label="Менеджер оформления"
                              placeholder="Все"
                            />
                          )}
                        />
                      </Grid>
                      <Grid item xs={12} md={6}>
                        <Autocomplete
                          multiple
                          disableCloseOnSelect
                          size="small"
                          fullWidth
                          options={sketchDesignerOptions}
                          value={pref.sketchDesignerNames}
                          onChange={(_, values) =>
                            patchFilters(status.id, { sketchDesignerNames: values })
                          }
                          noOptionsText="Нет художников"
                          renderInput={(params) => (
                            <TextField
                              {...params}
                              label="Художник эскиза"
                              placeholder="Все"
                            />
                          )}
                        />
                      </Grid>
                      <Grid item xs={12} md={6}>
                        <Autocomplete
                          multiple
                          disableCloseOnSelect
                          size="small"
                          fullWidth
                          options={revisionDesignerOptions}
                          value={pref.revisionDesignerNames}
                          onChange={(_, values) =>
                            patchFilters(status.id, { revisionDesignerNames: values })
                          }
                          noOptionsText="Нет художников"
                          renderInput={(params) => (
                            <TextField
                              {...params}
                              label="Художник правок"
                              placeholder="Все"
                            />
                          )}
                        />
                      </Grid>
                    </Grid>
                  )}
                </Box>
              )
            })}
          </Stack>
        )}

        <Box sx={{ mt: 2 }}>
          <Button variant="contained" onClick={() => void save()} disabled={saving}>
            {saving ? 'Сохранение…' : 'Сохранить'}
          </Button>
        </Box>
      </Paper>

      <Typography variant="body2" color="text.secondary">
        Пустой фильтр по людям — уведомления по всем заказам в статусе. Непустые категории
        работают как на доске заказов (AND между категориями).
      </Typography>
      <Typography variant="body2" color="text.secondary">
        Уведомления по чатам включаются и выключаются тумблером в разделе «Чаты».
      </Typography>
    </Box>
  )
}
