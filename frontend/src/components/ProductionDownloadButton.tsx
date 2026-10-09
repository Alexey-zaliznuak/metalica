import { useEffect, useRef, useState } from 'react'
import { Alert, Box, Button, CircularProgress } from '@mui/material'
import DownloadIcon from '@mui/icons-material/Download'
import { AxiosError } from 'axios'
import client from '../api/client'
import { describeApiError } from '../api/errors'
import { attachmentActionSx } from './AttachmentCard'

const compactActionSx = {
  minWidth: 0,
  height: 28,
  borderTop: 0,
  borderRadius: 0,
  fontSize: 11,
  lineHeight: 1,
  textTransform: 'none',
} as const

type ProductionStatus = 'pending' | 'processing' | 'ready' | 'failed'
interface StatusResponse { status: ProductionStatus; message: string | null }

export default function ProductionDownloadButton({
  orderId,
  attachmentId,
  textSize = '30x40',
  compact = false,
}: {
  orderId: number
  attachmentId: number
  textSize?: '30x40' | '40x60' | '60x80'
  compact?: boolean
}) {
  const [downloading, setDownloading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [status, setStatus] = useState<ProductionStatus | null>(null)
  const [refresh, setRefresh] = useState(0)
  const pending = useRef(false)
  const endpoint = `/orders/${orderId}/attachments/${attachmentId}/production`

  useEffect(() => {
    setNotice(null)
    setError(null)
  }, [orderId, attachmentId, textSize])

  useEffect(() => {
    let active = true
    let timer: number | undefined
    setStatus(null)
    const check = async () => {
      try {
        const { data } = await client.get<StatusResponse>(`${endpoint}/status`, { params: { textSize } })
        if (!active) return
        setStatus(data.status)
        if (data.status === 'failed') setError(data.message)
        if (data.status === 'ready') {
          setNotice((value) => value ? 'Файл готов. Можно скачать.' : null)
          setError(null)
        }
        if (data.status === 'pending' || data.status === 'processing') timer = window.setTimeout(check, 4000)
      } catch (err) {
        if (!active) return
        setError(describeApiError(err, 'Не удалось проверить готовность файла'))
      }
    }
    void check()
    return () => { active = false; if (timer !== undefined) window.clearTimeout(timer) }
  }, [endpoint, textSize, refresh])

  const download = async () => {
    if (pending.current) return
    if (status === 'pending' || status === 'processing') {
      setNotice('Файл ещё готовится в фоне. После завершения его можно будет скачать.')
      return
    }
    pending.current = true
    setDownloading(true)
    setError(null)
    setNotice(null)
    try {
      if (status !== 'ready') {
        const { data } = await client.post<StatusResponse>(endpoint, undefined, { params: { textSize } })
        setStatus(data.status)
        setNotice(data.status === 'ready' ? 'Файл готов. Можно скачать.' : 'Подготовка запущена в фоне. Файл можно будет скачать после завершения.')
        setRefresh((value) => value + 1)
        return
      }
      const response = await client.get<Blob>(endpoint, {
        responseType: 'blob',
        params: { textSize },
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
      if (err instanceof AxiosError && err.response?.status === 409) {
        setNotice(describeApiError(err, 'Файл ещё готовится в фоне'))
        setStatus('pending')
        setRefresh((value) => value + 1)
      } else setError(describeApiError(err, 'Не удалось скачать файл для производства'))
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
        variant={compact ? 'outlined' : 'text'}
        sx={compact ? compactActionSx : attachmentActionSx}
        disabled={downloading}
        onClick={() => void download()}
        startIcon={downloading || status === 'pending' || status === 'processing' ? <CircularProgress size={16} color="inherit" /> : <DownloadIcon />}
      >
        {downloading ? 'Загрузка…' : status === 'pending' || status === 'processing' ? 'Готовится…'
          : status === 'failed' ? 'Повторить подготовку' : compact ? 'Для производства' : 'Скачать для производства'}
      </Button>
      {error && <Alert severity="error" sx={{ m: 1, overflowWrap: 'anywhere' }}>{error}</Alert>}
      {notice && <Alert severity="info" sx={{ m: 1, overflowWrap: 'anywhere' }}>{notice}</Alert>}
    </Box>
  )
}
