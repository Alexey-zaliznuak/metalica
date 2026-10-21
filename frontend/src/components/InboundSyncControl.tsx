import { useEffect, useState } from 'react'
import { Alert, Box, Button, Card, CircularProgress, FormControlLabel, Stack, Switch, Typography } from '@mui/material'
import client from '../api/client'
import { describeApiError } from '../api/errors'
import type { InboundSyncState } from '../api/dev-metrics'

export default function InboundSyncControl() {
  const [state, setState] = useState<InboundSyncState | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [refresh, setRefresh] = useState(0)

  useEffect(() => {
    // Cancel older reads while saving so they cannot undo the displayed choice.
    if (saving) return
    let active = true
    let inFlight = false
    const controller = new AbortController()
    const load = async () => {
      if (inFlight) return
      inFlight = true
      setLoading(true)
      try {
        const response = await client.get<InboundSyncState>('/dev-metrics/inbound-sync', { signal: controller.signal })
        if (active) { setState(response.data); setError(null) }
      } catch (err) {
        if (active) setError(describeApiError(err, 'Не удалось загрузить режим Inbound-синка'))
      } finally {
        inFlight = false
        if (active) setLoading(false)
      }
    }
    void load()
    const timer = window.setInterval(() => { if (!document.hidden) void load() }, 30_000)
    return () => { active = false; controller.abort(); window.clearInterval(timer) }
  }, [refresh, saving])

  const changeMode = async (enabled: boolean) => {
    if (saving) return
    setSaving(true)
    setSaveError(null)
    try {
      const response = await client.patch<InboundSyncState>('/dev-metrics/inbound-sync', { enabled })
      setState(response.data)
    } catch (err) {
      setSaveError(describeApiError(err, 'Не удалось сохранить режим Inbound-синка'))
    } finally {
      setSaving(false)
    }
  }

  return <Card sx={{ p: { xs: 2, md: 3 } }}>
    <Stack spacing={2}>
      <Stack direction={{ xs: 'column', sm: 'row' }} alignItems={{ xs: 'stretch', sm: 'center' }} justifyContent="space-between" gap={2}>
        <Box>
          <Typography variant="h6">Inbound-синк · BlueSales → сайт</Typography>
          <Typography variant="body2" color="text.secondary">Управление импортом заказов, лидов и справочников из БС.</Typography>
        </Box>
        <Stack direction="row" alignItems="center" spacing={1}>
          {(loading || saving) && <CircularProgress size={20} aria-label={saving ? 'Сохранение режима' : 'Загрузка режима'} />}
          <FormControlLabel
            sx={{ mr: 0 }}
            control={<Switch checked={state?.enabled ?? false} disabled={!state || loading || saving || !!error} onChange={(_, checked) => void changeMode(checked)} inputProps={{ 'aria-label': 'Включить Inbound-синк из BlueSales' }} />}
            label={saving ? 'Сохранение…' : state ? state.enabled ? 'Включён' : 'Выключен' : 'Загрузка…'}
          />
        </Stack>
      </Stack>
      {error && <Alert severity="error" action={<Button color="inherit" size="small" disabled={loading} onClick={() => setRefresh((value) => value + 1)}>Повторить</Button>}>{error}</Alert>}
      {saveError && <Alert severity="error">{saveError}</Alert>}
      {state && <Alert severity={state.enabled ? 'info' : 'warning'}>
        {state.enabled
          ? 'Данные из БС обновляют карточки на сайте по расписанию. Если API БС временно недоступно, выключите Inbound-синк, чтобы после восстановления связи старые данные не затёрли изменения менеджеров.'
          : 'Импорт из БС и ручное обновление карточек приостановлены. Менеджеры могут продолжать работу на сайте: исходящая очередь отправляет локальные изменения в БС и повторяет попытки при сбоях.'}
      </Alert>}
      <Typography variant="body2" color="text.secondary">
        Включайте импорт после доставки накопленных изменений в БС. Режим сохраняется автоматически и действует без перезапуска сервера.
      </Typography>
    </Stack>
  </Card>
}
