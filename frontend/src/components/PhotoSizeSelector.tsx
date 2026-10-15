import { useRef, useState } from 'react'
import { Box, Button, CircularProgress, Typography } from '@mui/material'
import type { PhotoSize } from '../api/types'
import { describeApiError } from '../api/errors'
import { attachmentActionSx } from './AttachmentCard'

const PHOTO_SIZES = ['30x40', '40x60', '60x80'] as const
const photoSizeLabel = (size: string) => size.replace('x', ' х ')

export default function PhotoSizeSelector({ value, onChange, lightControls = false, fullWidth = false }: {
  value?: PhotoSize | null
  onChange: (size: PhotoSize) => Promise<void>
  lightControls?: boolean
  fullWidth?: boolean
}) {
  const [choosing, setChoosing] = useState(false)
  const [saving, setSaving] = useState<PhotoSize | null>(null)
  const [error, setError] = useState<string | null>(null)
  const pending = useRef(false)
  const actionSx = fullWidth ? attachmentActionSx : {
    minWidth: 0, height: 28, borderTop: 0, borderRadius: 0, px: 0.5,
    fontSize: 11, lineHeight: 1, textTransform: 'none',
    ...(lightControls ? { color: '#fff', borderColor: 'rgba(255,255,255,0.72)',
      '&:hover': { borderColor: '#fff', bgcolor: 'rgba(255,255,255,0.12)' },
      '&.Mui-disabled': { color: 'rgba(255,255,255,0.65)', borderColor: 'rgba(255,255,255,0.4)' },
    } : {}),
  }

  const selectSize = async (size: PhotoSize) => {
    if (pending.current) return
    pending.current = true
    setSaving(size)
    setError(null)
    try {
      await onChange(size)
      setChoosing(false)
    } catch (err) {
      setError(describeApiError(err, 'Не удалось сохранить размер фото'))
    } finally { pending.current = false; setSaving(null) }
  }

  return <Box sx={{ width: '100%' }}>
    {choosing ? <Box role="group" aria-label="Размер фото" sx={{ display: 'flex', flexDirection: 'column' }}>
      {PHOTO_SIZES.map((size, index) => <Button
        key={size} fullWidth size="small" variant={fullWidth ? 'text' : 'outlined'}
        sx={{ ...actionSx, borderRadius: index === PHOTO_SIZES.length - 1 ? '0 0 4px 4px' : 0 }}
        disabled={saving !== null} aria-pressed={value === size}
        onClick={() => void selectSize(size)}
        startIcon={saving === size ? <CircularProgress size={12} color="inherit" /> : undefined}
      >{photoSizeLabel(size)}</Button>)}
    </Box> : <Button fullWidth size="small" variant={fullWidth ? 'text' : 'outlined'}
      sx={{ ...actionSx, borderRadius: '0 0 4px 4px' }} onClick={() => { setError(null); setChoosing(true) }}
      aria-label={value ? `Изменить размер фото ${photoSizeLabel(value)}` : 'Установить размер фото'}
    >Установить размер</Button>}
    {error && <Typography role="alert" variant="caption" sx={{ display: 'block', px: 0.5, py: 0.5, color: lightControls ? '#fff' : 'error.main', overflowWrap: 'anywhere' }}>{error}</Typography>}
  </Box>
}
