import PictureAsPdfIcon from '@mui/icons-material/PictureAsPdf'
import { Box, Tooltip } from '@mui/material'
import AttachmentSizeBadge from './AttachmentSizeBadge'

const PDF_EXTENSION_PATTERN = /\.pdf$/i

interface PdfAttachmentLike {
  filename: string
  mimeType?: string | null
}

interface PdfAttachmentPreviewProps {
  bytes: number | null | undefined
  url?: string
  size?: number
}

export function isPdfAttachment(file: PdfAttachmentLike): boolean {
  return file.mimeType?.toLowerCase() === 'application/pdf' ||
    PDF_EXTENSION_PATTERN.test(file.filename)
}

export function isPdfFile(file: File): boolean {
  return isPdfAttachment({ filename: file.name, mimeType: file.type })
}

/**
 * PDF намеренно показывается без превью содержимого: только узнаваемая
 * иконка и размер. Для уже отправленного файла вся плитка открывает документ.
 */
export default function PdfAttachmentPreview({
  bytes,
  url,
  size = 120,
}: PdfAttachmentPreviewProps) {
  const tile = (
    <Box
      component={url ? 'a' : 'div'}
      href={url}
      target={url ? '_blank' : undefined}
      rel={url ? 'noopener noreferrer' : undefined}
      aria-label={url ? 'Открыть PDF' : 'PDF-файл'}
      sx={{
        position: 'relative',
        display: 'flex',
        width: size,
        height: size,
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: 1,
        border: '1px solid rgba(0,0,0,0.12)',
        bgcolor: 'action.hover',
        color: 'error.main',
        textDecoration: 'none',
        cursor: url ? 'pointer' : 'default',
        '&:hover': url ? { bgcolor: 'action.selected' } : undefined,
      }}
    >
      <PictureAsPdfIcon sx={{ fontSize: Math.round(size * 0.48) }} />
      <AttachmentSizeBadge bytes={bytes} />
    </Box>
  )

  return url ? <Tooltip title="Открыть PDF">{tile}</Tooltip> : tile
}
