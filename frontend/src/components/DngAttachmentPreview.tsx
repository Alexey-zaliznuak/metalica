import InsertDriveFileOutlinedIcon from '@mui/icons-material/InsertDriveFileOutlined'
import { Box, Tooltip, Typography } from '@mui/material'
import AttachmentSizeBadge from './AttachmentSizeBadge'

const DNG_EXTENSION_PATTERN = /\.dng$/i
const DNG_MIME_TYPES = new Set(['image/dng', 'image/x-adobe-dng'])

interface DngAttachmentLike {
  filename: string
  mimeType?: string | null
}

interface DngAttachmentPreviewProps {
  bytes: number | null | undefined
  filename: string
  url?: string
  size?: number
}

export function isDngAttachment(file: DngAttachmentLike): boolean {
  return DNG_EXTENSION_PATTERN.test(file.filename) ||
    DNG_MIME_TYPES.has(file.mimeType?.toLowerCase() ?? '')
}

export function isDngFile(file: File): boolean {
  return isDngAttachment({ filename: file.name, mimeType: file.type })
}

/**
 * DNG показывается как скачиваемый файл без попытки декодировать RAW и
 * построить миниатюру. Это также не даёт браузеру загружать тяжёлый файл в
 * память только ради превью в форме отправки.
 */
export default function DngAttachmentPreview({
  bytes,
  filename,
  url,
  size = 120,
}: DngAttachmentPreviewProps) {
  const tile = (
    <Box
      component={url ? 'a' : 'div'}
      href={url}
      download={url ? filename : undefined}
      aria-label={url ? `Скачать ${filename}` : `DNG-файл ${filename}`}
      sx={{
        position: 'relative',
        display: 'flex',
        width: size,
        height: size,
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 0.25,
        borderRadius: 1,
        border: '1px solid rgba(0,0,0,0.12)',
        bgcolor: 'action.hover',
        color: 'text.secondary',
        textDecoration: 'none',
        cursor: url ? 'pointer' : 'default',
        '&:hover': url ? { bgcolor: 'action.selected' } : undefined,
      }}
    >
      <InsertDriveFileOutlinedIcon sx={{ fontSize: Math.round(size * 0.42) }} />
      <Typography variant="caption" sx={{ fontWeight: 700, lineHeight: 1 }}>
        DNG
      </Typography>
      <AttachmentSizeBadge bytes={bytes} />
    </Box>
  )

  return url ? <Tooltip title={`Скачать ${filename}`}>{tile}</Tooltip> : tile
}
