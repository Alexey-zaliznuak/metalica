import { useEffect, useState } from 'react'
import CloseIcon from '@mui/icons-material/Close'
import DownloadIcon from '@mui/icons-material/Download'
import ImageIcon from '@mui/icons-material/Image'
import LinkIcon from '@mui/icons-material/Link'
import { Box, Button, CircularProgress, IconButton, Tooltip, Typography } from '@mui/material'

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

function isHeicImage(filename: string): boolean {
  return /\.(heic|heif)$/i.test(filename)
}

function useRenderableImageUrl(image: LightboxImage) {
  const isHeic = isHeicImage(image.filename)
  const [previewUrl, setPreviewUrl] = useState(isHeic ? '' : image.url)
  const [loading, setLoading] = useState(isHeic)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    if (!isHeic) {
      setPreviewUrl(image.url)
      setLoading(false)
      setFailed(false)
      return
    }

    let active = true
    let objectUrl: string | null = null
    setPreviewUrl('')
    setLoading(true)
    setFailed(false)

    void (async () => {
      try {
        const response = await fetch(image.url)
        if (!response.ok) throw new Error(`Не удалось загрузить HEIC: ${response.status}`)

        const { heicTo } = await import('heic-to')
        const previewBlob = await heicTo({
          blob: await response.blob(),
          type: 'image/jpeg',
          quality: 0.9,
        })
        objectUrl = URL.createObjectURL(previewBlob)

        if (active) setPreviewUrl(objectUrl)
        else URL.revokeObjectURL(objectUrl)
      } catch {
        if (active) setFailed(true)
      } finally {
        if (active) setLoading(false)
      }
    })()

    return () => {
      active = false
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [image.url, isHeic])

  return { previewUrl, loading, failed }
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

async function copyImageLink(url: string) {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(url)
      return
    } catch {
      // В небезопасном контексте или без разрешения используем старый способ.
    }
  }

  const textarea = document.createElement('textarea')
  textarea.value = url
  textarea.style.position = 'fixed'
  textarea.style.opacity = '0'
  document.body.appendChild(textarea)
  textarea.select()
  const copied = document.execCommand('copy')
  textarea.remove()
  if (!copied) throw new Error('Не удалось скопировать ссылку')
}

export function ImageAttachmentPreview({ image, onOpen }: ImageAttachmentPreviewProps) {
  const [downloading, setDownloading] = useState(false)
  const [copied, setCopied] = useState(false)
  const { previewUrl, loading, failed } = useRenderableImageUrl(image)

  const handleDownload = async () => {
    if (downloading) return
    setDownloading(true)
    try {
      await downloadImage(image)
    } finally {
      setDownloading(false)
    }
  }

  const handleCopyLink = async () => {
    try {
      await copyImageLink(image.url)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    } catch {
      setCopied(false)
    }
  }

  return (
    <Box sx={{ width: 120 }}>
      {loading || failed ? (
        <Box
          sx={{
            width: 120,
            height: 120,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 1,
            borderRadius: '4px 4px 0 0',
            border: '1px solid rgba(0,0,0,0.12)',
            borderBottom: 0,
            bgcolor: 'action.hover',
          }}
        >
          {loading ? <CircularProgress size={28} /> : <ImageIcon color="action" fontSize="large" />}
          <Typography variant="caption">
            {loading ? 'Обработка HEIC…' : 'Не удалось показать HEIC'}
          </Typography>
        </Box>
      ) : (
        <Box
          component="img"
          src={previewUrl}
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
      )}
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
          borderRadius: 0,
          fontSize: 11,
          lineHeight: 1,
          textTransform: 'none',
        }}
      >
        Скачать
      </Button>
      <Button
        fullWidth
        size="small"
        variant="outlined"
        startIcon={<LinkIcon />}
        onClick={() => void handleCopyLink()}
        sx={{
          minWidth: 0,
          height: 28,
          borderTop: 0,
          borderRadius: '0 0 4px 4px',
          fontSize: 11,
          lineHeight: 1,
          textTransform: 'none',
        }}
      >
        {copied ? 'Скопировано' : 'Копировать'}
      </Button>
    </Box>
  )
}

export default function ImageLightbox({ image, onClose }: ImageLightboxProps) {
  const [downloading, setDownloading] = useState(false)
  const { previewUrl, loading, failed } = useRenderableImageUrl(image)

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

      {loading ? (
        <CircularProgress color="inherit" />
      ) : failed ? (
        <Typography color="white">Не удалось отобразить HEIC-файл</Typography>
      ) : (
        <Box
          component="img"
          src={previewUrl}
          alt={image.filename}
          onClick={(event) => event.stopPropagation()}
          sx={{
            maxWidth: '95%',
            maxHeight: '95%',
            objectFit: 'contain',
            borderRadius: 1,
          }}
        />
      )}
    </Box>
  )
}
