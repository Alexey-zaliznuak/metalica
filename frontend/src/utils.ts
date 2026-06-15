import type { OrderStatus, MessageKind, UserRole } from './api/types'

export const ORDER_STATUS_LABELS: Record<OrderStatus, string> = {
  NEW: 'Новый',
  IN_PROGRESS: 'В работе',
  IN_REVISION: 'На правке',
  DONE: 'Готов',
}

export const ORDER_STATUSES: OrderStatus[] = [
  'NEW',
  'IN_PROGRESS',
  'IN_REVISION',
  'DONE',
]

type ChipColor =
  | 'default'
  | 'primary'
  | 'secondary'
  | 'success'
  | 'warning'
  | 'info'
  | 'error'

export const ORDER_STATUS_COLORS: Record<OrderStatus, ChipColor> = {
  NEW: 'secondary',
  IN_PROGRESS: 'info',
  IN_REVISION: 'warning',
  DONE: 'success',
}

export const MESSAGE_KIND_LABELS: Record<MessageKind, string> = {
  NORMAL: 'Обычное',
  REVISION_REQUEST: 'Запрос правки',
  REVISION_ANSWER: 'Правка готова',
}

export const ROLE_LABELS: Record<string, string> = {
  DESIGNER: 'Дизайнер',
  MANAGER: 'Менеджер',
  ADMIN: 'Администратор',
}

export function roleLabel(role: UserRole): string {
  return ROLE_LABELS[role] ?? role
}

// Roles an admin can assign when creating an account.
export const ASSIGNABLE_ROLES: { value: string; label: string }[] = [
  { value: 'MANAGER', label: ROLE_LABELS.MANAGER },
  { value: 'DESIGNER', label: ROLE_LABELS.DESIGNER },
  { value: 'ADMIN', label: ROLE_LABELS.ADMIN },
]

// Format a duration in seconds into a Russian human-readable string (ч/мин).
export function formatDuration(seconds: number | null | undefined): string {
  if (seconds == null || Number.isNaN(seconds) || seconds <= 0) {
    return '—'
  }
  const total = Math.round(seconds)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60

  if (h > 0) {
    return m > 0 ? `${h} ч ${m} мин` : `${h} ч`
  }
  if (m > 0) {
    return `${m} мин`
  }
  return `${s} сек`
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleString('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    year: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

export function formatTime(iso: string | null | undefined): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleTimeString('ru-RU', {
    hour: '2-digit',
    minute: '2-digit',
  })
}

// Relative-ish label for last activity (today shows time, else date).
export function formatLastActivity(iso: string | null | undefined): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  const now = new Date()
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate()
  if (sameDay) {
    return `сегодня ${formatTime(iso)}`
  }
  return formatDateTime(iso)
}
