import { useState } from 'react'
import CloseIcon from '@mui/icons-material/Close'
import DownloadIcon from '@mui/icons-material/Download'
import { Box, Button, CircularProgress, IconButton, Tooltip } from '@mui/material'

export interface LightboxImage {
  url: string
  filename: string
}

interface ImageLightboxProps {
  image: LightboxImage
  onClose: () => void
}

interface ImageAttachmentPreviewProps {
  image: LightboxImage
  onOpen: () => void
}

async function downloadImage(image: LightboxImage) {
  const response = await fetch(image.url)
  if (!response.ok) {
    throw new Error(`Не удалось скачать изображение: ${response.status}`)
  }

  const objectUrl = URL.createObjectURL(await response.blob())
  const link = document.createElement('a')
  link.href = objectUrl
  link.download = image.filename || 'image'
  document.body.appendChild(link)
  link.click()
  link.remove()
  URL.revokeObjectURL(objectUrl)
}

export function ImageAttachmentPreview({ image, onOpen }: ImageAttachmentPreviewProps) {
  const [downloading, setDownloading] = useState(false)

  const handleDownload = async () => {
    if (downloading) return
    setDownloading(true)
    try {
      await downloadImage(image)
    } finally {
      setDownloading(false)
    }
  }

  return (
    <Box sx={{ width: 120 }}>
      <Box
        component="img"
        src={image.url}
        alt={image.filename}
        loading="lazy"
        decoding="async"
        onClick={onOpen}
        sx={{
          display: 'block',
          width: 120,
          height: 120,
          objectFit: 'cover',
          borderRadius: '4px 4px 0 0',
          cursor: 'pointer',
          border: '1px solid rgba(0,0,0,0.12)',
          borderBottom: 0,
        }}
      />
      <Button
        fullWidth
        size="small"
        variant="outlined"
        startIcon={
          downloading ? <CircularProgress size={14} color="inherit" /> : <DownloadIcon />
        }
        disabled={downloading}
        onClick={() => void handleDownload()}
        sx={{
          minWidth: 0,
          height: 28,
          borderRadius: '0 0 4px 4px',
          fontSize: 11,
          lineHeight: 1,
          textTransform: 'none',
        }}
      >
        Скачать
      </Button>
    </Box>
  )
}

export default function ImageLightbox({ image, onClose }: ImageLightboxProps) {
  const [downloading, setDownloading] = useState(false)

  const handleDownload = async () => {
    if (downloading) return
    setDownloading(true)

    try {
      await downloadImage(image)
    } finally {
      setDownloading(false)
    }
  }

  return (
    <Box
      onClick={onClose}
      sx={{
        position: 'fixed',
        inset: 0,
        bgcolor: 'rgba(0,0,0,0.85)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 1400,
        p: 2,
      }}
    >
      <Box
        sx={{
          position: 'absolute',
          top: 16,
          right: 16,
          display: 'flex',
          gap: 0.5,
        }}
      >
        <Tooltip title="Скачать">
          <span>
            <IconButton
              aria-label="Скачать изображение"
              disabled={downloading}
              onClick={(event) => {
                event.stopPropagation()
                void handleDownload()
              }}
              sx={{ color: '#fff' }}
            >
              {downloading ? <CircularProgress size={24} color="inherit" /> : <DownloadIcon />}
            </IconButton>
          </span>
        </Tooltip>
        <Tooltip title="Закрыть">
          <IconButton
            aria-label="Закрыть"
            onClick={(event) => {
              event.stopPropagation()
              onClose()
            }}
            sx={{ color: '#fff' }}
          >
            <CloseIcon />
          </IconButton>
        </Tooltip>
      </Box>

      <Box
        component="img"
        src={image.url}
        alt={image.filename}
        onClick={(event) => event.stopPropagation()}
        sx={{
          maxWidth: '95%',
          maxHeight: '95%',
          objectFit: 'contain',
          borderRadius: 1,
        }}
      />
    </Box>
  )
}
