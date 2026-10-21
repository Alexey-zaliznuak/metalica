import { Box, Chip, Stack, Typography } from '@mui/material'
import type { ProductionChange } from '../api/dev-metrics'

export const causeLabels: Record<string, string> = {
  new_attachment: 'Новое прикреплённое фото', backfill: 'Подготовка ранее прикреплённого фото',
  first_request: 'Первая подготовка по запросу', initial_unknown: 'Первичная подготовка (старый журнал)',
  data_change: 'Изменение данных для печати', manual_retry: 'Ручной повтор после ошибки',
  automatic_retry: 'Автоматический повтор после ошибки', renderer_change: 'Обновление формата файла',
  legacy_unknown: 'Причина не записана',
}
const sourceLabels: Record<string, string> = {
  attachment_added: 'Прикрепление фото', order_update: 'Изменение заказа', background_scan: 'Фоновая проверка',
  status: 'Запрос готовности', download: 'Скачивание', expedite: 'Подготовка вне очереди', worker: 'Проверка перед / после обработки',
}
const fieldLabels: Record<string, string> = {
  orderNumber: 'Номер заказа', photoNumber: 'Номер фото', articles: 'Печатаемые позиции', comment: 'Комментарий',
  deliveryService: 'Доставка', sourceFile: 'Исходный файл', renderer: 'Формат файла',
}
const valueText = (value: ProductionChange['before']) => Array.isArray(value) ? value.join('\n') || '—' : value == null || value === '' ? '—' : String(value)
export const causeLabel = (cause: string | null, reason?: string) => causeLabels[cause ?? ''] ??
  (reason === 'changed' ? causeLabels.data_change : reason === 'retry' ? causeLabels.manual_retry : reason === 'created' ? causeLabels.initial_unknown : causeLabels.legacy_unknown)

export default function ProductionTaskDetails({ cause, trigger, changes, reason }: {
  cause: string | null; trigger: string | null; changes: ProductionChange[] | null; reason?: string
}) {
  return <Stack spacing={1}>
    <Box><Chip size="small" variant="outlined" label={causeLabel(cause, reason)} />{trigger && <Typography variant="caption" color="text.secondary" display="block" mt={0.5}>Источник: {sourceLabels[trigger] ?? trigger}</Typography>}</Box>
    {changes?.map((change) => <Box key={change.field}>
      <Typography variant="caption" fontWeight={700}>{fieldLabels[change.field] ?? change.field}</Typography>
      <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', md: '1fr 1fr' }, gap: 1, mt: 0.5 }}>
        <Box sx={{ p: 1, bgcolor: '#fff3e0', borderRadius: 1 }}><Typography variant="caption" fontWeight={700}>Было</Typography><Typography variant="body2" sx={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{valueText(change.before)}</Typography></Box>
        <Box sx={{ p: 1, bgcolor: '#eaf5eb', borderRadius: 1 }}><Typography variant="caption" fontWeight={700}>Стало</Typography><Typography variant="body2" sx={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{valueText(change.after)}</Typography></Box>
      </Box>
    </Box>)}
    {changes == null && <Typography variant="caption" color="text.secondary">Для этой старой постановки значения «было → стало» не записывались.</Typography>}
  </Stack>
}
