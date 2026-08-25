import { useCallback, useEffect, useMemo, useState, type DragEvent } from 'react'
import {
  Alert,
  Box,
  Button,
  Checkbox,
  Chip,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControlLabel,
  IconButton,
  InputAdornment,
  List,
  ListItem,
  ListItemButton,
  ListItemText,
  Paper,
  Stack,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material'
import ArrowDownwardIcon from '@mui/icons-material/ArrowDownward'
import ArrowUpwardIcon from '@mui/icons-material/ArrowUpward'
import DragIndicatorIcon from '@mui/icons-material/DragIndicator'
import SaveIcon from '@mui/icons-material/Save'
import client from '../api/client'
import { describeApiError, logApiError } from '../api/errors'
import type {
  BluesalesStatusOption,
  OrderStatusSettingsPayload,
} from '../api/types'

/**
 * Автораспределение художника правок пока скрыто из интерфейса: бэкенд его
 * поддерживает и уже сохранённые значения не сбрасываются, но включить
 * настройку нельзя. Поставьте true, чтобы вернуть её в модалку и сводку.
 */
const SHOW_REVISION_ASSIGNMENT = false

// Порог «огонька» в UI задаётся часами и минутами, а хранится одним числом минут.
interface ThresholdDraft {
  hours: string
  minutes: string
}

function idsOf(statuses: BluesalesStatusOption[]) {
  return statuses.map((status) => status.id)
}

function draftFromMinutes(total: number | null): ThresholdDraft {
  if (total == null) return { hours: '', minutes: '' }
  return { hours: String(Math.floor(total / 60)), minutes: String(total % 60) }
}

function minutesFromDraft(draft: ThresholdDraft): number | null {
  const hours = Math.max(Number(draft.hours) || 0, 0)
  const minutes = Math.max(Number(draft.minutes) || 0, 0)
  const total = Math.round(hours * 60 + minutes)
  return total > 0 ? total : null
}

function formatThreshold(total: number | null): string | null {
  if (total == null) return null
  const hours = Math.floor(total / 60)
  const minutes = total % 60
  if (hours > 0) return minutes > 0 ? `${hours} ч ${minutes} мин` : `${hours} ч`
  return `${minutes} мин`
}

// Краткая сводка настроек в строке списка: подробности — в модалке.
function StatusSummary({ status }: { status: BluesalesStatusOption }) {
  const chips: string[] = []
  if (status.closesSketch) chips.push('Закрывает эскиз')
  if (status.showTimeInStatus) {
    const threshold = formatThreshold(status.alertAfterMinutes)
    chips.push(threshold ? `Таймер · ${threshold}` : 'Таймер')
  }
  if (status.assignSketchDesigner) chips.push('Авто: эскиз')
  if (SHOW_REVISION_ASSIGNMENT && status.assignRevisionDesigner) {
    chips.push('Авто: правки')
  }

  if (chips.length === 0) {
    return (
      <Typography variant="body2" color="text.secondary">
        Без настроек
      </Typography>
    )
  }
  return (
    <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap>
      {chips.map((chip) => (
        <Chip key={chip} size="small" label={chip} variant="outlined" />
      ))}
    </Stack>
  )
}

interface SettingsDialogProps {
  status: BluesalesStatusOption | null
  saving: boolean
  error: string | null
  onClose: () => void
  onSave: (next: OrderStatusSettingsPayload) => void
}

function StatusSettingsDialog({
  status,
  saving,
  error,
  onClose,
  onSave,
}: SettingsDialogProps) {
  const [closesSketch, setClosesSketch] = useState(false)
  const [showTimeInStatus, setShowTimeInStatus] = useState(false)
  const [threshold, setThreshold] = useState<ThresholdDraft>({
    hours: '',
    minutes: '',
  })
  const [assignSketch, setAssignSketch] = useState(false)
  const [assignRevision, setAssignRevision] = useState(false)

  // Форму заполняем при каждом открытии, чтобы не показывать чужой черновик.
  useEffect(() => {
    if (!status) return
    setClosesSketch(status.closesSketch)
    setShowTimeInStatus(status.showTimeInStatus)
    setThreshold(draftFromMinutes(status.alertAfterMinutes))
    setAssignSketch(status.assignSketchDesigner)
    setAssignRevision(status.assignRevisionDesigner)
  }, [status])

  return (
    <Dialog
      open={status !== null}
      onClose={() => !saving && onClose()}
      fullWidth
      maxWidth="sm"
    >
      <DialogTitle>
        {status?.name}
        <Typography variant="body2" color="text.secondary">
          Настройки статуса · ID {status?.id}
        </Typography>
      </DialogTitle>
      <DialogContent>
        <Stack spacing={2.5} sx={{ mt: 1 }}>
          {error && <Alert severity="error">{error}</Alert>}

          <Box>
            <Typography variant="subtitle2" sx={{ fontWeight: 700, mb: 0.5 }}>
              Автоматическое назначение художника
            </Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
              При входе заказа в этот статус художник подбирается по кругу
              направления заказа. Уже назначенного художника автораспределение не
              заменяет, а ночью (с 21:00 до 10:00) не работает вовсе.
            </Typography>
            <Stack>
              <FormControlLabel
                control={
                  <Checkbox
                    checked={assignSketch}
                    disabled={saving}
                    onChange={(event) => setAssignSketch(event.target.checked)}
                  />
                }
                label="Нужно назначить художника эскиза"
              />
              {SHOW_REVISION_ASSIGNMENT && (
                <FormControlLabel
                  control={
                    <Checkbox
                      checked={assignRevision}
                      disabled={saving}
                      onChange={(event) => setAssignRevision(event.target.checked)}
                    />
                  }
                  label="Нужно назначить художника правок"
                />
              )}
            </Stack>
          </Box>

          <Box>
            <Typography variant="subtitle2" sx={{ fontWeight: 700, mb: 0.5 }}>
              Эскиз
            </Typography>
            <FormControlLabel
              control={
                <Checkbox
                  checked={closesSketch}
                  disabled={saving}
                  onChange={(event) => setClosesSketch(event.target.checked)}
                />
              }
              label="Закрывать эскиз (отметить начатым и готовым)"
            />
          </Box>

          <Box>
            <Typography variant="subtitle2" sx={{ fontWeight: 700, mb: 0.5 }}>
              Таймер на доске
            </Typography>
            <FormControlLabel
              control={
                <Checkbox
                  checked={showTimeInStatus}
                  disabled={saving}
                  onChange={(event) => setShowTimeInStatus(event.target.checked)}
                />
              }
              label="Показывать, сколько заказ находится в статусе"
            />
            <Typography variant="body2" color="text.secondary" sx={{ mt: 1, mb: 1 }}>
              Порог: через сколько времени таймер краснеет и появляется огонёк.
              Пусто — без огонька.
            </Typography>
            <Stack direction="row" spacing={1}>
              <TextField
                size="small"
                type="number"
                placeholder="0"
                label="Часы"
                value={threshold.hours}
                disabled={!showTimeInStatus || saving}
                onChange={(event) =>
                  setThreshold((current) => ({
                    ...current,
                    hours: event.target.value,
                  }))
                }
                inputProps={{ min: 0, max: 8760 }}
                InputProps={{
                  endAdornment: <InputAdornment position="end">ч</InputAdornment>,
                }}
                sx={{ width: 120 }}
              />
              <TextField
                size="small"
                type="number"
                placeholder="0"
                label="Минуты"
                value={threshold.minutes}
                disabled={!showTimeInStatus || saving}
                onChange={(event) =>
                  setThreshold((current) => ({
                    ...current,
                    minutes: event.target.value,
                  }))
                }
                inputProps={{ min: 0, max: 59 }}
                InputProps={{
                  endAdornment: <InputAdornment position="end">мин</InputAdornment>,
                }}
                sx={{ width: 130 }}
              />
            </Stack>
          </Box>
        </Stack>
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2 }}>
        <Button onClick={onClose} disabled={saving}>
          Отмена
        </Button>
        <Button
          variant="contained"
          disabled={saving}
          startIcon={saving ? <CircularProgress size={18} color="inherit" /> : null}
          onClick={() =>
            onSave({
              showTimeInStatus,
              alertAfterMinutes: minutesFromDraft(threshold),
              closesSketch,
              assignSketchDesigner: assignSketch,
              assignRevisionDesigner: assignRevision,
            })
          }
        >
          Сохранить
        </Button>
      </DialogActions>
    </Dialog>
  )
}

export default function OrderStatusesPage() {
  const [statuses, setStatuses] = useState<BluesalesStatusOption[]>([])
  const [savedIds, setSavedIds] = useState<number[]>([])
  const [draggedId, setDraggedId] = useState<number | null>(null)
  const [editing, setEditing] = useState<BluesalesStatusOption | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [savingSettings, setSavingSettings] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [dialogError, setDialogError] = useState<string | null>(null)
  const [success, setSuccess] = useState(false)

  const fetchStatuses = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const { data } =
        await client.get<BluesalesStatusOption[]>('/orders/order-statuses')
      setStatuses(data)
      setSavedIds(idsOf(data))
    } catch (err) {
      logApiError('загрузка статусов заказов', err)
      setError(describeApiError(err, 'Не удалось загрузить статусы заказов'))
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
    } catch (err) {
      logApiError('сохранение порядка статусов', err)
      setError(
        describeApiError(
          err,
          'Не удалось сохранить порядок. Обновите страницу и попробуйте снова.',
        ),
      )
    } finally {
      setSaving(false)
    }
  }

  // Настройки сохраняются независимо от несохранённого порядка, поэтому
  // локальный sortOrder оставляем прежним.
  const saveSettings = async (next: OrderStatusSettingsPayload) => {
    if (!editing) return
    setSavingSettings(true)
    setDialogError(null)
    try {
      const { data } = await client.patch<BluesalesStatusOption>(
        `/orders/order-statuses/${editing.id}/settings`,
        next,
      )
      setStatuses((current) =>
        current.map((item) =>
          item.id === data.id ? { ...data, sortOrder: item.sortOrder } : item,
        ),
      )
      setEditing(null)
    } catch (err) {
      logApiError(`сохранение настроек статуса «${editing.name}»`, err)
      setDialogError(
        describeApiError(err, `Не удалось сохранить настройки статуса «${editing.name}»`),
      )
    } finally {
      setSavingSettings(false)
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
            Порядок задаётся перетаскиванием за ручку или стрелками — верхние
            статусы показываются на доске первыми. Клик по статусу открывает его
            настройки: закрытие эскиза, таймер на доске и автоматическое
            назначение художника.
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
                disablePadding
                onDragOver={(event) => event.preventDefault()}
                onDrop={(event) => handleDrop(event, index)}
                sx={{
                  bgcolor:
                    draggedId === status.id ? 'action.selected' : 'background.paper',
                }}
                secondaryAction={
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
                }
              >
                {/* Перетаскивание вешаем только на ручку: клик по строке
                    открывает настройки статуса. */}
                <Tooltip title="Перетащите, чтобы изменить порядок">
                  <Box
                    draggable={!saving}
                    onDragStart={() => setDraggedId(status.id)}
                    onDragEnd={() => setDraggedId(null)}
                    sx={{
                      display: 'flex',
                      alignItems: 'center',
                      pl: 2,
                      cursor: saving ? 'default' : 'grab',
                      '&:active': { cursor: saving ? 'default' : 'grabbing' },
                    }}
                  >
                    <DragIndicatorIcon color="disabled" />
                  </Box>
                </Tooltip>
                <ListItemButton
                  onClick={() => {
                    setDialogError(null)
                    setEditing(status)
                  }}
                  sx={{ gap: 2, pr: 12 }}
                >
                  <Typography
                    color="text.secondary"
                    sx={{ width: 32, textAlign: 'right', flexShrink: 0 }}
                  >
                    {index + 1}
                  </Typography>
                  <ListItemText
                    primary={status.name}
                    secondary={`ID: ${status.id}`}
                    sx={{ flex: '1 1 40%' }}
                  />
                  <Box sx={{ flex: '1 1 60%' }}>
                    <StatusSummary status={status} />
                  </Box>
                </ListItemButton>
              </ListItem>
            ))}
          </List>
        )}
      </Paper>

      <StatusSettingsDialog
        status={editing}
        saving={savingSettings}
        error={dialogError}
        onClose={() => setEditing(null)}
        onSave={(next) => void saveSettings(next)}
      />
    </Box>
  )
}
