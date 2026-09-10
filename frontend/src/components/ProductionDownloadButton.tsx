import { useRef, useState } from 'react'
import { Alert, Box, Button, CircularProgress } from '@mui/material'
import DownloadIcon from '@mui/icons-material/Download'
import { AxiosError } from 'axios'
import client from '../api/client'
import { describeApiError } from '../api/errors'
import { attachmentActionSx } from './AttachmentCard'

export default function ProductionDownloadButton({ orderId, attachmentId }: {
  orderId: number
  attachmentId: number
}) {
  const [downloading, setDownloading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const pending = useRef(false)

  const download = async () => {
    if (pending.current) return
    pending.current = true
    setDownloading(true)
    setError(null)
    try {
      const response = await client.get<Blob>(`/orders/${orderId}/attachments/${attachmentId}/production`, {
        responseType: 'blob',
      })
      const url = URL.createObjectURL(response.data)
      const link = document.createElement('a')
      link.href = url
      link.download = /filename="([^"]+)"/.exec(response.headers['content-disposition'] ?? '')?.[1]
        ?? `production-${orderId}-${attachmentId}.png`
      document.body.appendChild(link)
      link.click()
      link.remove()
      // Give the browser time to start saving before releasing the Blob URL.
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000)
    } catch (err) {
      // Axios returns JSON errors as blobs too when responseType is 'blob'.
      if (err instanceof AxiosError && err.response?.data instanceof Blob) {
        try { err.response.data = JSON.parse(await err.response.data.text()) } catch { /* use the HTTP error */ }
      }
      setError(describeApiError(err, 'Не удалось скачать файл для производства'))
    } finally {
      pending.current = false
      setDownloading(false)
    }
  }

  return (
    <Box sx={{ width: '100%' }}>
      <Button
        fullWidth
        size="small"
        color="primary"
        sx={attachmentActionSx}
        disabled={downloading}
        onClick={() => void download()}
        startIcon={downloading ? <CircularProgress size={16} color="inherit" /> : <DownloadIcon />}
      >
        {downloading ? 'Подготовка файла…' : 'Скачать для производства'}
      </Button>
      {error && <Alert severity="error" sx={{ m: 1, overflowWrap: 'anywhere' }}>{error}</Alert>}
    </Box>
  )
}
