import { AxiosError } from 'axios'

// Лимит из MAX_UPLOAD_MB бэкенда: держим в курсе пользователя ещё до отправки,
// чтобы он не ждал впустую загрузку файла, который сервер всё равно отклонит.
export const MAX_UPLOAD_MB = 300
export const MAX_UPLOAD_BYTES = MAX_UPLOAD_MB * 1024 * 1024

const STATUS_HINTS: Record<number, string> = {
  401: 'Сессия истекла — войдите заново',
  403: 'Нет прав на это действие',
  404: 'Данные не найдены — возможно, их уже удалили',
  409: 'Данные успели измениться — обновите страницу',
  413: `Файл слишком большой (лимит ${MAX_UPLOAD_MB} МБ)`,
  429: 'Слишком много запросов — подождите немного',
  502: 'Сервер недоступен',
  503: 'Сервер недоступен',
  504: 'Сервер не ответил вовремя — при больших файлах попробуйте отправить их по одному',
}

function serverMessage(error: AxiosError<{ message?: string | string[] }>): string | null {
  const message = error.response?.data?.message
  if (Array.isArray(message)) {
    const joined = message.filter(Boolean).join(', ')
    return joined || null
  }
  return typeof message === 'string' && message.trim() ? message : null
}

/**
 * Человекочитаемая причина сбоя запроса. Приоритет: текст от бэкенда ->
 * подсказка по HTTP-статусу -> переданный fallback. Статус добавляем в
 * скобках, когда своего текста у ошибки нет: с ним обращение в поддержку
 * сразу указывает, где искать в логах.
 */
export function describeApiError(error: unknown, fallback: string): string {
  const axiosError = error as AxiosError<{ message?: string | string[] }>

  if (!axiosError?.isAxiosError) {
    const message = error instanceof Error ? error.message : String(error)
    return `${fallback}: ${message}`
  }

  if (axiosError.code === 'ECONNABORTED' || axiosError.code === 'ETIMEDOUT') {
    return `${fallback}: превышено время ожидания сервера`
  }

  // Ответа нет вовсе: сеть отвалилась, запрос отменён или сервер не поднялся.
  if (!axiosError.response) {
    return `${fallback}: нет связи с сервером, проверьте интернет`
  }

  const status = axiosError.response.status
  const fromServer = serverMessage(axiosError)
  if (fromServer) return fromServer

  const hint = STATUS_HINTS[status]
  if (hint) return hint

  return `${fallback} (ошибка ${status})`
}

/**
 * Пишет ошибку в консоль браузера. Нужна там, где сбой не показывается
 * пользователю (фоновые подгрузки, polling): иначе такие ошибки исчезают
 * бесследно и потом невозможно понять, почему данные не обновились.
 */
export function logApiError(context: string, error: unknown): void {
  const axiosError = error as AxiosError<{ message?: string | string[] }>
  if (axiosError?.isAxiosError) {
    console.error(
      `[api] ${context}: ${axiosError.config?.method?.toUpperCase() ?? ''} ` +
        `${axiosError.config?.url ?? ''} -> ${axiosError.response?.status ?? axiosError.code ?? 'нет ответа'}`,
      axiosError.response?.data ?? axiosError.message,
    )
    return
  }
  console.error(`[api] ${context}`, error)
}

export function formatBytes(bytes: number): string {
  if (!bytes || bytes < 0) return '0 Б'
  const units = ['Б', 'КБ', 'МБ', 'ГБ']
  const power = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1)
  const value = bytes / 1024 ** power
  return `${power === 0 ? value : value.toFixed(1)} ${units[power]}`
}
