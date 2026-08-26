import type { MessageKind, OrderDirection, UserRole } from './api/types'

export const MESSAGE_KIND_LABELS: Record<MessageKind, string> = {
  NORMAL: 'Обычное',
  REVISION_REQUEST: 'Запрос правки',
  REVISION_ANSWER: 'Правка готова',
}

export const ROLE_LABELS: Record<string, string> = {
  SKETCH_DESIGNER: 'Художник эскиза',
  REVISION_DESIGNER: 'Художник правок',
  MANAGER: 'Менеджер',
  PRODUCTION: 'Производство',
  ADMIN: 'Администратор',
}

export function roleLabel(role: UserRole): string {
  return ROLE_LABELS[role] ?? role
}

// Roles an admin can assign when creating an account.
export const ASSIGNABLE_ROLES: { value: string; label: string }[] = [
  { value: 'MANAGER', label: ROLE_LABELS.MANAGER },
  { value: 'SKETCH_DESIGNER', label: ROLE_LABELS.SKETCH_DESIGNER },
  { value: 'REVISION_DESIGNER', label: ROLE_LABELS.REVISION_DESIGNER },
  { value: 'PRODUCTION', label: ROLE_LABELS.PRODUCTION },
  { value: 'ADMIN', label: ROLE_LABELS.ADMIN },
]

export const SCOPE_LABELS: Record<string, string> = {
  ORDERS_CHANGE_RESPONSIBLE: 'Изменять ответственных заказа',
  METRICS_VIEW: 'Просмотр метрик',
  WORKLOAD_VIEW: 'Просмотр нагрузки',
  ARTIST_SHIFTS_MANAGE: 'Управление сменами художников',
}

export const ASSIGNABLE_SCOPES: { value: string; label: string }[] = [
  {
    value: 'ORDERS_CHANGE_RESPONSIBLE',
    label: SCOPE_LABELS.ORDERS_CHANGE_RESPONSIBLE,
  },
  {
    value: 'METRICS_VIEW',
    label: SCOPE_LABELS.METRICS_VIEW,
  },
  {
    value: 'WORKLOAD_VIEW',
    label: SCOPE_LABELS.WORKLOAD_VIEW,
  },
  {
    value: 'ARTIST_SHIFTS_MANAGE',
    label: SCOPE_LABELS.ARTIST_SHIFTS_MANAGE,
  },
]

export function scopeLabel(scope: string): string {
  return SCOPE_LABELS[scope] ?? scope
}

export function canManageArtistShifts(
  role: UserRole | undefined,
  scopes: string[] | undefined,
): boolean {
  return (
    role === 'ADMIN' ||
    role === 'MANAGER' ||
    (scopes ?? []).includes('ARTIST_SHIFTS_MANAGE')
  )
}

// Роли, участвующие в автораспределении заказов: у них есть смена и направления.
export const DESIGNER_ROLES: UserRole[] = ['SKETCH_DESIGNER', 'REVISION_DESIGNER']

export function isDesignerRole(role: UserRole | undefined): boolean {
  return role !== undefined && DESIGNER_ROLES.includes(role)
}

export const DIRECTION_LABELS: Record<string, string> = {
  PHOTO_RETOUCH: 'Фотопечать + ретушь',
  NEURO_ART: 'Нейро-арт',
  DIGITAL: 'Digital',
}

export const ASSIGNABLE_DIRECTIONS: { value: OrderDirection; label: string }[] = [
  { value: 'PHOTO_RETOUCH', label: DIRECTION_LABELS.PHOTO_RETOUCH },
  { value: 'NEURO_ART', label: DIRECTION_LABELS.NEURO_ART },
  { value: 'DIGITAL', label: DIRECTION_LABELS.DIGITAL },
]

export function directionLabel(direction: string): string {
  return DIRECTION_LABELS[direction] ?? direction
}

// Проверка наличия скоупа у пользователя. ADMIN всегда имеет доступ.
// Значение скоупа сравнивается без учёта регистра и разделителя (. / _),
// чтобы совпадало и с "METRICS_VIEW", и с "metrics.view".
export function hasScope(
  role: string | undefined,
  scopes: string[] | undefined,
  scope: string,
): boolean {
  if ((role ?? '').toUpperCase() === 'ADMIN') return true
  const normalize = (value: string) => value.toUpperCase().replace(/\./g, '_')
  const target = normalize(scope)
  return (scopes ?? []).some((s) => normalize(s) === target)
}

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

// Компактная длительность для таймера на карточке: «12м», «3ч 20м», «2д 5ч».
// nowTs передаётся снаружи, чтобы все карточки тикали одним состоянием.
export function formatDurationShort(
  iso: string | null | undefined,
  nowTs: number,
): string {
  if (!iso) return '—'
  const started = new Date(iso).getTime()
  if (Number.isNaN(started)) return '—'
  const minutes = Math.max(Math.floor((nowTs - started) / 60000), 0)
  if (minutes < 60) return `${minutes}м`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) {
    const rest = minutes % 60
    return rest > 0 ? `${hours}ч ${rest}м` : `${hours}ч`
  }
  const days = Math.floor(hours / 24)
  const restHours = hours % 24
  return restHours > 0 ? `${days}д ${restHours}ч` : `${days}д`
}

const MOSCOW_TIME_ZONE = 'Europe/Moscow'

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleString('ru-RU', {
    timeZone: MOSCOW_TIME_ZONE,
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
    timeZone: MOSCOW_TIME_ZONE,
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
  const moscowDateFormatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: MOSCOW_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
  const sameDay = moscowDateFormatter.format(d) === moscowDateFormatter.format(now)
  if (sameDay) {
    return `сегодня ${formatTime(iso)}`
  }
  return formatDateTime(iso)
}
