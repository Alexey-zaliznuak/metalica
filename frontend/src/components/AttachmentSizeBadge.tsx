import { Box } from '@mui/material'
import { formatBytes } from '../api/errors'

interface AttachmentSizeBadgeProps {
  bytes: number | null | undefined
  photoSize?: string | null
}

/**
 * Размер файла поверх превью вложения. Абсолютное позиционирование выбрано
 * намеренно: подпись не сдвигает соседние элементы и одинаково работает и на
 * миниатюре в ленте, и на превью ещё не отправленного файла. Родитель должен
 * иметь position: relative.
 */
export default function AttachmentSizeBadge({ bytes, photoSize }: AttachmentSizeBadgeProps) {
  if (bytes == null && !photoSize) return null

  return (
    <Box
      component="span"
      sx={{
        position: 'absolute',
        right: 4,
        bottom: 4,
        px: 0.6,
        py: '1px',
        borderRadius: 0.75,
        bgcolor: 'rgba(0,0,0,0.62)',
        color: '#fff',
        fontSize: 10,
        fontWeight: 600,
        lineHeight: 1.5,
        letterSpacing: 0.2,
        whiteSpace: 'nowrap',
        pointerEvents: 'none',
        backdropFilter: 'blur(2px)',
      }}
    >
      {photoSize && <Box component="span" sx={{ display: 'block' }}>{photoSize.replace('x', ' х ')}</Box>}
      {bytes != null && <Box component="span" sx={{ display: 'block' }}>{formatBytes(bytes)}</Box>}
    </Box>
  )
}
