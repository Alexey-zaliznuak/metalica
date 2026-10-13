import { useCallback, useEffect, useRef, useState } from 'react'
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
interface StatusResponse { status: ProductionStatus; message: string | null; expedited: boolean }

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
  const [expediting, setExpediting] = useState(false)
  const [expedited, setExpedited] = useState(false)
  const autoDownload = useRef<string | null>(null)
  const urgentPending = useRef(false)
  const pending = useRef(false)
  const endpoint = `/orders/${orderId}/attachments/${attachmentId}/production`
  const requestKey = `${endpoint}:${textSize}`
  const currentKey = useRef(requestKey)
  currentKey.current = requestKey

  const saveReadyFile = useCallback(async (automatic = false) => {
    if (pending.current) return
    pending.current = true
    setDownloading(true)
    setError(null)
    setNotice(null)
    try {
      const response = await client.get<Blob>(endpoint, { responseType: 'blob', params: { textSize } })
      if (currentKey.current !== requestKey) return
      const url = URL.createObjectURL(response.data)
      const link = document.createElement('a')
      link.href = url
      link.download = /filename="([^"]+)"/.exec(response.headers['content-disposition'] ?? '')?.[1]
        ?? `production-${orderId}-${attachmentId}.png`
      document.body.appendChild(link)
      link.click()
      link.remove()
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000)
    } catch (err) {
      if (currentKey.current !== requestKey) return
      if (err instanceof AxiosError && err.response?.data instanceof Blob) {
        try { err.response.data = JSON.parse(await err.response.data.text()) } catch { /* use the HTTP error */ }
      }
      if (currentKey.current !== requestKey) return
      if (err instanceof AxiosError && err.response?.status === 409) {
        if (automatic) autoDownload.current = requestKey
        setNotice(describeApiError(err, 'Файл ещё готовится в фоне'))
        setStatus('pending')
        setRefresh((value) => value + 1)
      } else setError(describeApiError(err, 'Не удалось скачать файл для производства'))
    } finally {
      pending.current = false
      setDownloading(false)
    }
  }, [endpoint, textSize, requestKey, orderId, attachmentId])

  useEffect(() => {
    currentKey.current = requestKey
    setNotice(null)
    setError(null)
    setExpedited(false)
    autoDownload.current = null
    return () => { if (currentKey.current === requestKey) currentKey.current = '' }
  }, [requestKey])

  useEffect(() => {
    let active = true
    let timer: number | undefined
    setStatus(null)
    const check = async () => {
      try {
        const { data } = await client.get<StatusResponse>(`${endpoint}/status`, { params: { textSize } })
        if (!active) return
        setStatus(data.status)
        setExpedited(data.expedited)
        if (data.status === 'failed') { setError(data.message); autoDownload.current = null }
        if (data.status === 'ready') {
          setNotice((value) => value ? 'Файл готов. Можно скачать.' : null)
          setError(null)
        }
        if (data.status === 'pending' || data.status === 'processing') timer = window.setTimeout(check, 4000)
      } catch (err) {
        if (!active) return
        setError(describeApiError(err, 'Не удалось проверить готовность файла'))
        if (!(err instanceof AxiosError) || !err.response || err.response.status >= 500) timer = window.setTimeout(check, 4000)
      }
    }
    void check()
    return () => { active = false; if (timer !== undefined) window.clearTimeout(timer) }
  }, [endpoint, textSize, refresh])

  useEffect(() => {
    if (status === 'ready' && !expediting && !downloading && autoDownload.current === requestKey) {
      autoDownload.current = null
      void saveReadyFile(true)
    }
  }, [status, expediting, downloading, requestKey, saveReadyFile])

  const expedite = async () => {
    if (urgentPending.current || pending.current) return
    urgentPending.current = true
    setExpediting(true)
    setError(null)
    autoDownload.current = requestKey
    try {
      const { data } = await client.post<StatusResponse>(`${endpoint}/expedite`, undefined, { params: { textSize } })
      if (currentKey.current !== requestKey) return
      setStatus(data.status)
      setExpedited(data.expedited)
      setNotice(data.status === 'processing'
        ? 'Файл обрабатывается. Скачивание начнётся автоматически после подготовки.'
        : 'Выбранный размер поставлен в начало очереди. Скачивание начнётся автоматически после подготовки.')
      setRefresh((value) => value + 1)
    } catch (err) {
      if (currentKey.current !== requestKey) return
      autoDownload.current = null
      setError(describeApiError(err, 'Не удалось ускорить подготовку файла'))
    } finally { urgentPending.current = false; setExpediting(false) }
  }

  const download = async () => {
    if (pending.current) return
    if (status === 'ready') { await saveReadyFile(); return }
    if (status === 'pending' || status === 'processing') {
      setNotice('Файл ещё готовится в фоне. После завершения его можно будет скачать.')
      return
    }
    pending.current = true
    setDownloading(true)
    setError(null)
    setNotice(null)
    try {
      const { data } = await client.post<StatusResponse>(endpoint, undefined, { params: { textSize } })
      if (currentKey.current !== requestKey) return
      setStatus(data.status)
      setNotice(data.status === 'ready' ? 'Файл готов. Можно скачать.' : 'Подготовка запущена в фоне. Файл можно будет скачать после завершения.')
      setRefresh((value) => value + 1)
    } catch (err) {
      if (currentKey.current === requestKey) setError(describeApiError(err, 'Не удалось подготовить файл для производства'))
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
        disabled={downloading || expediting}
        onClick={() => void download()}
        startIcon={downloading || status === 'pending' || status === 'processing' ? <CircularProgress size={16} color="inherit" /> : <DownloadIcon />}
      >
        {downloading ? 'Загрузка…' : status === 'pending' || status === 'processing' ? 'Готовится…'
          : status === 'failed' ? 'Повторить подготовку' : compact ? 'Для производства' : 'Скачать для производства'}
      </Button>
      {(status === 'pending' || status === 'processing') && <Button
        fullWidth
        size="small"
        color="warning"
        variant="outlined"
        sx={compact ? compactActionSx : attachmentActionSx}
        disabled={expediting || downloading}
        onClick={() => void expedite()}
        startIcon={expediting ? <CircularProgress size={16} color="inherit" /> : <DownloadIcon />}
        title={expedited ? 'Файл уже в приоритетной очереди; скачать автоматически после подготовки' : 'Подготовить выбранный размер с приоритетом и скачать автоматически'}
      >{expediting ? 'Ускоряем…' : 'Скачать досрочно'}</Button>}
      {error && <Alert severity="error" sx={{ m: 1, overflowWrap: 'anywhere' }}>{error}</Alert>}
      {notice && <Alert severity="info" sx={{ m: 1, overflowWrap: 'anywhere' }}>{notice}</Alert>}
    </Box>
  )
}
