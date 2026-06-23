import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type DragEvent,
  type ReactNode,
} from 'react'
import {
  Alert,
  Avatar,
  Box,
  Button,
  Chip,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  IconButton,
  Link,
  MenuItem,
  Paper,
  Stack,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Tooltip,
  Typography,
} from '@mui/material'
import ArrowBackIcon from '@mui/icons-material/ArrowBack'
import SendIcon from '@mui/icons-material/Send'
import ImageIcon from '@mui/icons-material/Image'
import CloseIcon from '@mui/icons-material/Close'
import ReplyIcon from '@mui/icons-material/Reply'
import CheckCircleIcon from '@mui/icons-material/CheckCircle'
import EditNoteIcon from '@mui/icons-material/EditNote'
import EditIcon from '@mui/icons-material/Edit'
import OpenInNewIcon from '@mui/icons-material/OpenInNew'
import PersonIcon from '@mui/icons-material/Person'
import ReceiptLongIcon from '@mui/icons-material/ReceiptLong'
import { AxiosError } from 'axios'
import { useNavigate, useParams } from 'react-router-dom'
import client from '../api/client'
import type {
  BluesalesStatusOption,
  Message,
  MessageKind,
  OrderAssignee,
  Order,
  OrderMetrics,
  UpdateOrderPayload,
  UploadResponse,
} from '../api/types'
import { useAuth } from '../auth/AuthContext'
import { BRAND, ACCENT } from '../theme'
import {
  formatDateTime,
  formatDuration,
  formatTime,
  roleLabel,
} from '../utils'

interface PendingImage {
  id: string
  file: File
  previewUrl: string
}

interface AssigneesResponse {
  managers: OrderAssignee[]
  designers: OrderAssignee[]
}

const EMPTY_ASSIGNEES: AssigneesResponse = {
  managers: [],
  designers: [],
}

function plural(n: number, one: string, few: string, many: string): string {
  const mod10 = n % 10
  const mod100 = n % 100
  if (mod10 === 1 && mod100 !== 11) return one
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return few
  return many
}

// Render a resolution duration (in seconds) as "n часов m минут" with
// correct Russian pluralization. Falls back to minutes/seconds when short.
function formatRevisionResolution(seconds: number): string {
  const total = Math.max(0, Math.round(seconds))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const parts: string[] = []
  if (h > 0) parts.push(`${h} ${plural(h, 'час', 'часа', 'часов')}`)
  if (m > 0) parts.push(`${m} ${plural(m, 'минуту', 'минуты', 'минут')}`)
  if (parts.length === 0) {
    const s = total % 60
    return `${s} ${plural(s, 'секунду', 'секунды', 'секунд')}`
  }
  return parts.join(' ')
}

function initials(name: string): string {
  return name
    .split(' ')
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() ?? '')
    .join('')
}

function canEditOrderResponsibles(role: string | undefined, scopes: string[] | undefined): boolean {
  if ((role ?? '').toUpperCase() === 'ADMIN') return true
  const normalizedScopes = (scopes ?? []).map((scope) => scope.toUpperCase())
  return (
    normalizedScopes.includes('ORDERS_CHANGE_RESPONSIBLE') ||
    normalizedScopes.includes('ORDERS.CHANGE_RESPONSIBLE')
  )
}

// Decide which side a message sits on. We anchor the current user to the right,
// otherwise designers go left / managers go right as a visual convention.
function isOwnSide(authorId: number, currentUserId: number | undefined): boolean {
  return authorId === currentUserId
}

function MessageBubble({
  message,
  ownSide,
  onOpenImage,
  resolvedSeconds,
}: {
  message: Message
  ownSide: boolean
  onOpenImage: (url: string) => void
  resolvedSeconds?: number | null
}) {
  const isRequest = message.kind === 'REVISION_REQUEST'
  const isAnswer = message.kind === 'REVISION_ANSWER'
  const isResolved = isRequest && resolvedSeconds != null

  // Semantic styling: blue messages, orange revision requests, green answers.
  // Revision messages keep their accent regardless of side so the thread is
  // easy to scan; normal messages follow the chat convention (own = blue).
  let bubbleBg: string = ownSide
    ? `linear-gradient(135deg, ${BRAND.deep}, ${BRAND.main})`
    : '#ffffff'
  let bubbleColor: string = ownSide ? '#ffffff' : 'text.primary'
  let accentBorder = ownSide ? 'none' : `1px solid ${BRAND.pale}`
  let leftBar: string | undefined

  if (isRequest) {
    bubbleBg = ACCENT.revisionSoft
    bubbleColor = '#5a3000'
    accentBorder = `1px solid ${ACCENT.revision}33`
    leftBar = ACCENT.revision
  } else if (isAnswer) {
    bubbleBg = ACCENT.resolutionSoft
    bubbleColor = '#11401a'
    accentBorder = `1px solid ${ACCENT.resolution}33`
    leftBar = ACCENT.resolution
  }

  return (
    <Box
      sx={{
        display: 'flex',
        justifyContent: ownSide ? 'flex-end' : 'flex-start',
        mb: 1.5,
      }}
    >
      <Stack
        direction={ownSide ? 'row-reverse' : 'row'}
        spacing={1}
        sx={{ maxWidth: '80%' }}
      >
        <Avatar
          sx={{
            width: 34,
            height: 34,
            fontSize: 13,
            color: '#fff',
            background: ownSide
              ? `linear-gradient(135deg, ${BRAND.deep}, ${BRAND.main})`
              : `linear-gradient(135deg, ${BRAND.main}, ${BRAND.light})`,
          }}
        >
          {initials(message.author.name)}
        </Avatar>
        <Box>
          <Stack
            direction="row"
            spacing={1}
            alignItems="center"
            justifyContent={ownSide ? 'flex-end' : 'flex-start'}
            sx={{ mb: 0.3 }}
          >
            <Typography variant="caption" sx={{ fontWeight: 600 }}>
              {message.author.name}
            </Typography>
            <Typography variant="caption" color="text.secondary">
              {roleLabel(message.author.role)}
            </Typography>
          </Stack>

          <Paper
            elevation={0}
            sx={{
              p: 1.5,
              background: bubbleBg,
              color: bubbleColor,
              border: accentBorder,
              borderLeft: leftBar ? `4px solid ${leftBar}` : accentBorder,
              borderRadius: 1.5,
              boxShadow: `0 4px 14px ${BRAND.deep}1f`,
            }}
          >
            {(isRequest || isAnswer) && (
              <Box sx={{ mb: 0.8 }}>
                <Chip
                  size="small"
                  icon={
                    isRequest ? (
                      <EditNoteIcon sx={{ color: '#fff !important', fontSize: 16 }} />
                    ) : (
                      <CheckCircleIcon
                        sx={{ color: '#fff !important', fontSize: 16 }}
                      />
                    )
                  }
                  label={isRequest ? 'Запрос правки' : 'Правка готова'}
                  sx={{
                    bgcolor: isRequest ? ACCENT.revision : ACCENT.resolution,
                    color: '#fff',
                    fontWeight: 700,
                  }}
                />
              </Box>
            )}

            {isAnswer && message.answerTo && (
              <Box
                sx={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 0.5,
                  mb: 0.8,
                  px: 1,
                  py: 0.5,
                  borderRadius: 1,
                  bgcolor: `${ACCENT.resolution}14`,
                }}
              >
                <ReplyIcon sx={{ fontSize: 16 }} />
                <Typography variant="caption" sx={{ fontStyle: 'italic' }}>
                  ответ на правку:{' '}
                  {message.answerTo.body
                    ? message.answerTo.body.slice(0, 60)
                    : '(без текста)'}
                </Typography>
              </Box>
            )}

            {message.body && (
              <Typography
                variant="body2"
                sx={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}
              >
                {message.body}
              </Typography>
            )}

            {message.attachments.length > 0 && (
              <Box
                sx={{
                  display: 'flex',
                  flexWrap: 'wrap',
                  gap: 1,
                  mt: message.body ? 1 : 0,
                }}
              >
                {message.attachments.map((att) => (
                  <Box
                    key={att.id}
                    component="img"
                    src={att.url}
                    alt={att.filename}
                    onClick={() => onOpenImage(att.url)}
                    sx={{
                      width: 120,
                      height: 120,
                      objectFit: 'cover',
                      borderRadius: 1,
                      cursor: 'pointer',
                      border: '1px solid rgba(0,0,0,0.12)',
                    }}
                  />
                ))}
              </Box>
            )}

            <Typography
              variant="caption"
              sx={{
                display: 'block',
                textAlign: 'right',
                mt: 0.5,
                opacity: 0.7,
              }}
            >
              {formatTime(message.createdAt)}
            </Typography>

            {isResolved && (
              <Box
                sx={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 0.5,
                  mt: 0.8,
                  pt: 0.6,
                  borderTop: `1px solid ${ACCENT.resolution}33`,
                }}
              >
                <CheckCircleIcon sx={{ fontSize: 14, color: ACCENT.resolution }} />
                <Typography
                  variant="caption"
                  sx={{ fontWeight: 700, color: ACCENT.resolution }}
                >
                  Решена за {formatRevisionResolution(resolvedSeconds!)}
                </Typography>
              </Box>
            )}
          </Paper>
        </Box>
      </Stack>
    </Box>
  )
}

function InfoRow({
  label,
  value,
}: {
  label: string
  value: ReactNode
}) {
  return (
    <Stack
      direction="row"
      spacing={1}
      justifyContent="space-between"
      alignItems="baseline"
      sx={{ py: 0.4 }}
    >
      <Typography
        variant="caption"
        color="text.secondary"
        sx={{ flexShrink: 0 }}
      >
        {label}
      </Typography>
      <Typography
        variant="body2"
        sx={{ fontWeight: 600, textAlign: 'right', wordBreak: 'break-word' }}
      >
        {value}
      </Typography>
    </Stack>
  )
}

function SectionTitle({
  icon,
  children,
}: {
  icon: ReactNode
  children: ReactNode
}) {
  return (
    <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 0.5 }}>
      <Box sx={{ display: 'flex', color: BRAND.main }}>{icon}</Box>
      <Typography variant="subtitle2" sx={{ fontWeight: 800 }}>
        {children}
      </Typography>
    </Stack>
  )
}

function OrderInfoPanel({
  order,
  orderStatusOptions,
  managerAssignees,
  designerAssignees,
  canReassignResponsible,
  updatingOrderStatus,
  updatingResponsible,
  onOrderStatusChange,
  onResponsibleChange,
}: {
  order: Order
  orderStatusOptions: BluesalesStatusOption[]
  managerAssignees: OrderAssignee[]
  designerAssignees: OrderAssignee[]
  canReassignResponsible: boolean
  updatingOrderStatus: boolean
  updatingResponsible: boolean
  onOrderStatusChange: (statusId: number) => void
  onResponsibleChange: (
    field:
      | 'deliveryManagerId'
      | 'onboardingManagerId'
      | 'sketchDesignerId'
      | 'revisionDesignerId',
    userId: number | '',
  ) => void
}) {
  const bs = order.bluesalesInfo
  const lead = order.lead
  const dash = '—'

  return (
    <Paper
      variant="outlined"
      sx={{
        width: 320,
        flexShrink: 0,
        p: 2,
        borderRadius: 1.5,
        overflowY: 'auto',
        display: { xs: 'none', md: 'block' },
      }}
    >
      <SectionTitle icon={<ReceiptLongIcon fontSize="small" />}>
        Информация о заказе
      </SectionTitle>
      <Stack divider={<Divider flexItem />}>
        <InfoRow label="Номер" value={order.orderNumber} />
        <InfoRow
          label="Источник"
          value={
            <Chip
              size="small"
              label={order.source === 'BLUESALES' ? 'BlueSales' : 'Вручную'}
              color={order.source === 'BLUESALES' ? 'info' : 'default'}
              sx={{ fontWeight: 700, height: 22 }}
            />
          }
        />
        <InfoRow label="Создан" value={formatDateTime(order.createdAt)} />
        <Box sx={{ py: 0.6 }}>
          <TextField
            select
            label="Менеджер ведения"
            size="small"
            value={order.deliveryManager?.id != null ? String(order.deliveryManager.id) : ''}
            onChange={(e) =>
              onResponsibleChange(
                'deliveryManagerId',
                e.target.value ? Number(e.target.value) : '',
              )
            }
            fullWidth
            disabled={!canReassignResponsible || updatingResponsible}
            helperText={
              managerAssignees.length === 0
                ? 'Нет пользователей с ролью менеджера'
                : !canReassignResponsible
                  ? 'Только просмотр: нужен скоуп на изменение ответственных'
                  : undefined
            }
          >
            <MenuItem value="">Не назначен</MenuItem>
            {order.deliveryManager &&
              !managerAssignees.some((assignee) => assignee.id === order.deliveryManager!.id) && (
                <MenuItem value={String(order.deliveryManager.id)}>
                  {order.deliveryManager.name}
                </MenuItem>
              )}
            {managerAssignees.map((assignee) => (
              <MenuItem key={assignee.id} value={String(assignee.id)}>
                {assignee.name}
              </MenuItem>
            ))}
          </TextField>
        </Box>
        <Box sx={{ py: 0.6 }}>
          <TextField
            select
            label="Менеджер оформления"
            size="small"
            value={order.onboardingManager?.id != null ? String(order.onboardingManager.id) : ''}
            onChange={(e) =>
              onResponsibleChange(
                'onboardingManagerId',
                e.target.value ? Number(e.target.value) : '',
              )
            }
            fullWidth
            disabled={!canReassignResponsible || updatingResponsible}
            helperText={
              managerAssignees.length === 0
                ? 'Нет пользователей с ролью менеджера'
                : !canReassignResponsible
                  ? 'Только просмотр: нужен скоуп на изменение ответственных'
                  : undefined
            }
          >
            <MenuItem value="">Не назначен</MenuItem>
            {order.onboardingManager &&
              !managerAssignees.some((assignee) => assignee.id === order.onboardingManager!.id) && (
                <MenuItem value={String(order.onboardingManager.id)}>
                  {order.onboardingManager.name}
                </MenuItem>
              )}
            {managerAssignees.map((assignee) => (
              <MenuItem key={assignee.id} value={String(assignee.id)}>
                {assignee.name}
              </MenuItem>
            ))}
          </TextField>
        </Box>
        <Box sx={{ py: 0.6 }}>
          <TextField
            select
            label="Художник эскиза"
            size="small"
            value={order.sketchDesigner?.id != null ? String(order.sketchDesigner.id) : ''}
            onChange={(e) =>
              onResponsibleChange(
                'sketchDesignerId',
                e.target.value ? Number(e.target.value) : '',
              )
            }
            fullWidth
            disabled={!canReassignResponsible || updatingResponsible}
            helperText={
              designerAssignees.length === 0
                ? 'Нет пользователей с ролью художника'
                : !canReassignResponsible
                  ? 'Только просмотр: нужен скоуп на изменение ответственных'
                  : undefined
            }
          >
            <MenuItem value="">Не назначен</MenuItem>
            {order.sketchDesigner &&
              !designerAssignees.some((assignee) => assignee.id === order.sketchDesigner!.id) && (
                <MenuItem value={String(order.sketchDesigner.id)}>
                  {order.sketchDesigner.name}
                </MenuItem>
              )}
            {designerAssignees.map((assignee) => (
              <MenuItem key={assignee.id} value={String(assignee.id)}>
                {assignee.name}
              </MenuItem>
            ))}
          </TextField>
        </Box>
        <Box sx={{ py: 0.6 }}>
          <TextField
            select
            label="Художник правок"
            size="small"
            value={order.revisionDesigner?.id != null ? String(order.revisionDesigner.id) : ''}
            onChange={(e) =>
              onResponsibleChange(
                'revisionDesignerId',
                e.target.value ? Number(e.target.value) : '',
              )
            }
            fullWidth
            disabled={!canReassignResponsible || updatingResponsible}
            helperText={
              designerAssignees.length === 0
                ? 'Нет пользователей с ролью художника'
                : !canReassignResponsible
                  ? 'Только просмотр: нужен скоуп на изменение ответственных'
                  : undefined
            }
          >
            <MenuItem value="">Не назначен</MenuItem>
            {order.revisionDesigner &&
              !designerAssignees.some(
                (assignee) => assignee.id === order.revisionDesigner!.id,
              ) && (
                <MenuItem value={String(order.revisionDesigner.id)}>
                  {order.revisionDesigner.name}
                </MenuItem>
              )}
            {designerAssignees.map((assignee) => (
              <MenuItem key={assignee.id} value={String(assignee.id)}>
                {assignee.name}
              </MenuItem>
            ))}
          </TextField>
        </Box>
      </Stack>

      {bs && (
        <Box sx={{ mt: 2 }}>
          <SectionTitle icon={<ReceiptLongIcon fontSize="small" />}>
            Данные BlueSales
          </SectionTitle>
          <Stack divider={<Divider flexItem />}>
            <InfoRow label="№ в BS" value={bs.bsNumber ?? bs.bsOrderId} />
            <Box sx={{ py: 0.6 }}>
              <TextField
                select
                label="Статус заказа"
                size="small"
                value={order.orderStatusId != null ? String(order.orderStatusId) : ''}
                onChange={(e) => {
                  if (!e.target.value) return
                  onOrderStatusChange(Number(e.target.value))
                }}
                fullWidth
                disabled={
                  updatingOrderStatus ||
                  order.source !== 'BLUESALES' ||
                  orderStatusOptions.length === 0
                }
              >
                {order.source !== 'BLUESALES' && (
                  <MenuItem value="">Недоступно для ручного заказа</MenuItem>
                )}
                {order.source === 'BLUESALES' && <MenuItem value="">Не выбран</MenuItem>}
                {order.orderStatusId != null && orderStatusOptions.length === 0 && (
                  <MenuItem value={String(order.orderStatusId)}>
                    {order.orderStatus ?? `Статус #${order.orderStatusId}`}
                  </MenuItem>
                )}
                {orderStatusOptions.map((status) => (
                  <MenuItem key={status.id} value={String(status.id)}>
                    {status.name}
                  </MenuItem>
                ))}
              </TextField>
            </Box>
            <InfoRow label="CRM-статус" value={bs.crmStatus ?? dash} />
            <InfoRow
              label="Сумма"
              value={
                bs.totalSum != null
                  ? `${bs.totalSum.toLocaleString('ru-RU')} ₽`
                  : dash
              }
            />
            <InfoRow
              label="Создан в BS"
              value={formatDateTime(bs.bsCreatedAt)}
            />
            <InfoRow
              label="Синхронизирован"
              value={formatDateTime(bs.lastSyncedAt)}
            />
          </Stack>
        </Box>
      )}

      <Box sx={{ mt: 2 }}>
        <SectionTitle icon={<PersonIcon fontSize="small" />}>
          Клиент
        </SectionTitle>
        {lead ? (
          <Stack divider={<Divider flexItem />}>
            <InfoRow label="ФИО" value={lead.fullName ?? lead.name ?? dash} />
            {lead.name && lead.name !== lead.fullName && (
              <InfoRow label="Имя" value={lead.name} />
            )}
            <InfoRow label="CRM-статус" value={lead.crmStatus ?? dash} />
            <InfoRow
              label="Диалог в ВК"
              value={
                lead.vkDialogUrl ? (
                  <Link
                    href={lead.vkDialogUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    sx={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 0.5,
                      fontWeight: 700,
                    }}
                  >
                    Открыть
                    <OpenInNewIcon sx={{ fontSize: 15 }} />
                  </Link>
                ) : (
                  dash
                )
              }
            />
            <InfoRow
              label="Обновлён"
              value={formatDateTime(lead.lastSyncedAt)}
            />
          </Stack>
        ) : (
          <Typography variant="body2" color="text.secondary">
            Клиент не привязан
          </Typography>
        )}
      </Box>
    </Paper>
  )
}

export default function OrderThreadPage() {
  const { id } = useParams<{ id: string }>()
  const orderId = Number(id)
  const navigate = useNavigate()
  const { user } = useAuth()

  const [order, setOrder] = useState<Order | null>(null)
  const [orderStatuses, setOrderStatuses] = useState<BluesalesStatusOption[]>([])
  const [managerAssignees, setManagerAssignees] = useState<OrderAssignee[]>([])
  const [designerAssignees, setDesignerAssignees] = useState<OrderAssignee[]>([])
  const [metrics, setMetrics] = useState<OrderMetrics | null>(null)
  const [messages, setMessages] = useState<Message[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [body, setBody] = useState('')
  const [kind, setKind] = useState<MessageKind>('NORMAL')
  const [pendingImages, setPendingImages] = useState<PendingImage[]>([])
  const [sending, setSending] = useState(false)
  const [sendError, setSendError] = useState<string | null>(null)
  const [dragOver, setDragOver] = useState(false)
  const [lightbox, setLightbox] = useState<string | null>(null)

  const [editOpen, setEditOpen] = useState(false)
  const [editNumber, setEditNumber] = useState('')
  const [editTitle, setEditTitle] = useState('')
  const [editDeliveryManagerId, setEditDeliveryManagerId] = useState<number | ''>('')
  const [editOnboardingManagerId, setEditOnboardingManagerId] = useState<number | ''>('')
  const [editSketchDesignerId, setEditSketchDesignerId] = useState<number | ''>('')
  const [editRevisionDesignerId, setEditRevisionDesignerId] = useState<number | ''>('')
  const [savingEdit, setSavingEdit] = useState(false)
  const [editError, setEditError] = useState<string | null>(null)
  const [updatingOrderStatus, setUpdatingOrderStatus] = useState(false)
  const [updatingResponsible, setUpdatingResponsible] = useState(false)

  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const listEndRef = useRef<HTMLDivElement | null>(null)
  const canReassignResponsible = canEditOrderResponsibles(user?.role, user?.scopes)

  const loadAll = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const [orderRes, metricsRes, messagesRes, statusesRes, assigneesRes] = await Promise.all([
        client.get<Order>(`/orders/${orderId}`),
        client.get<OrderMetrics>(`/orders/${orderId}/metrics`),
        client.get<Message[]>(`/orders/${orderId}/messages`),
        client.get<BluesalesStatusOption[]>('/orders/order-statuses'),
        canReassignResponsible
          ? client.get<AssigneesResponse>('/orders/assignees')
          : Promise.resolve({ data: EMPTY_ASSIGNEES }),
      ])
      setOrder(orderRes.data)
      setMetrics(metricsRes.data)
      setMessages(messagesRes.data)
      setOrderStatuses(statusesRes.data)
      setManagerAssignees(assigneesRes.data.managers)
      setDesignerAssignees(assigneesRes.data.designers)
    } catch {
      setError('Не удалось загрузить заказ')
    } finally {
      setLoading(false)
    }
  }, [canReassignResponsible, orderId])

  useEffect(() => {
    if (Number.isFinite(orderId)) {
      loadAll()
    }
  }, [orderId, loadAll])

  // Auto-scroll to bottom when messages change.
  useEffect(() => {
    listEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  const refreshOrderMeta = useCallback(async () => {
    try {
      const [orderRes, metricsRes] = await Promise.all([
        client.get<Order>(`/orders/${orderId}`),
        client.get<OrderMetrics>(`/orders/${orderId}/metrics`),
      ])
      setOrder(orderRes.data)
      setMetrics(metricsRes.data)
    } catch {
      /* non-critical */
    }
  }, [orderId])

  const orderStatusOptions = useMemo(() => {
    const map = new Map<number, string>()
    for (const s of orderStatuses) {
      map.set(s.id, s.name)
    }
    if (order?.orderStatusId != null && order.orderStatus) {
      map.set(order.orderStatusId, order.orderStatus)
    }
    return Array.from(map.entries())
      .map(([id, name]) => ({ id, name }))
      .sort((a, b) => a.name.localeCompare(b.name, 'ru'))
  }, [orderStatuses, order?.orderStatusId, order?.orderStatus])

  const handleOrderStatusChange = async (statusId: number) => {
    if (!order) return
    const nextName =
      orderStatusOptions.find((s) => s.id === statusId)?.name ?? order.orderStatus
    const prev = order
    setUpdatingOrderStatus(true)
    setOrder({
      ...order,
      orderStatusId: statusId,
      orderStatus: nextName ?? null,
    })
    try {
      const { data } = await client.patch<Order>(`/orders/${orderId}/order-status`, {
        statusId,
      })
      setOrder(data)
    } catch {
      setOrder(prev)
      setSendError('Не удалось изменить статус заказа')
    } finally {
      setUpdatingOrderStatus(false)
    }
  }

  const handleResponsibleChange = async (
    field:
      | 'deliveryManagerId'
      | 'onboardingManagerId'
      | 'sketchDesignerId'
      | 'revisionDesignerId',
    userId: number | '',
  ) => {
    if (!order || !canReassignResponsible) return
    setUpdatingResponsible(true)
    try {
      const payload: UpdateOrderPayload = {
        [field]: userId === '' ? null : userId,
      }
      const { data } = await client.patch<Order>(`/orders/${orderId}`, payload)
      setOrder(data)
    } catch {
      setSendError('Не удалось изменить ответственного')
    } finally {
      setUpdatingResponsible(false)
    }
  }

  const openEdit = () => {
    if (!order) return
    setEditNumber(order.orderNumber)
    setEditTitle(order.title || '')
    setEditDeliveryManagerId(order.deliveryManager?.id ?? '')
    setEditOnboardingManagerId(order.onboardingManager?.id ?? '')
    setEditSketchDesignerId(order.sketchDesigner?.id ?? '')
    setEditRevisionDesignerId(order.revisionDesigner?.id ?? '')
    setEditError(null)
    setEditOpen(true)
  }

  const handleSaveEdit = async () => {
    if (!order || !editNumber.trim()) return
    setSavingEdit(true)
    setEditError(null)
    try {
      const payload: UpdateOrderPayload = {
        orderNumber: editNumber.trim(),
        title: editTitle.trim(),
        ...(canReassignResponsible
          ? {
              deliveryManagerId: editDeliveryManagerId === '' ? null : editDeliveryManagerId,
              onboardingManagerId:
                editOnboardingManagerId === '' ? null : editOnboardingManagerId,
              sketchDesignerId: editSketchDesignerId === '' ? null : editSketchDesignerId,
              revisionDesignerId:
                editRevisionDesignerId === '' ? null : editRevisionDesignerId,
            }
          : {}),
      }
      const { data } = await client.patch<Order>(`/orders/${orderId}`, payload)
      setOrder(data)
      setEditOpen(false)
    } catch (err) {
      const status = (err as AxiosError)?.response?.status
      setEditError(
        status === 409
          ? 'Заказ с таким номером уже существует'
          : 'Не удалось сохранить изменения',
      )
    } finally {
      setSavingEdit(false)
    }
  }

  const addFiles = useCallback((files: FileList | File[]) => {
    const images = Array.from(files).filter((f) => f.type.startsWith('image/'))
    if (images.length === 0) return
    setPendingImages((prev) => [
      ...prev,
      ...images.map((file) => ({
        id: `${file.name}-${file.size}-${Date.now()}-${Math.random()}`,
        file,
        previewUrl: URL.createObjectURL(file),
      })),
    ])
  }, [])

  const removePending = (id: string) => {
    setPendingImages((prev) => {
      const target = prev.find((p) => p.id === id)
      if (target) URL.revokeObjectURL(target.previewUrl)
      return prev.filter((p) => p.id !== id)
    })
  }

  // Clean up object URLs on unmount.
  useEffect(() => {
    return () => {
      pendingImages.forEach((p) => URL.revokeObjectURL(p.previewUrl))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const handlePaste = (e: ClipboardEvent<HTMLDivElement>) => {
    const items = e.clipboardData?.files
    if (items && items.length > 0) {
      const imgs = Array.from(items).filter((f) => f.type.startsWith('image/'))
      if (imgs.length > 0) {
        e.preventDefault()
        addFiles(imgs)
      }
    }
  }

  const handleDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    setDragOver(false)
    if (e.dataTransfer?.files?.length) {
      addFiles(e.dataTransfer.files)
    }
  }

  // Map each resolved REVISION_REQUEST id to the time (in seconds) it took to
  // resolve, derived from the first REVISION_ANSWER that replies to it.
  const resolutionByRequestId = useMemo(() => {
    const requestById = new Map<number, Message>()
    for (const m of messages) {
      if (m.kind === 'REVISION_REQUEST') requestById.set(m.id, m)
    }
    const result = new Map<number, number>()
    for (const m of messages) {
      if (m.kind !== 'REVISION_ANSWER' || m.answerToId == null) continue
      const request = requestById.get(m.answerToId)
      if (!request) continue
      const seconds =
        (new Date(m.createdAt).getTime() - new Date(request.createdAt).getTime()) /
        1000
      if (Number.isNaN(seconds) || seconds < 0) continue
      // Keep the earliest answer if multiple exist.
      if (!result.has(request.id) || seconds < result.get(request.id)!) {
        result.set(request.id, seconds)
      }
    }
    return result
  }, [messages])

  const canSend = useMemo(
    () => (body.trim().length > 0 || pendingImages.length > 0) && !sending,
    [body, pendingImages.length, sending],
  )

  const handleSend = async () => {
    if (!canSend) return
    setSending(true)
    setSendError(null)
    try {
      // 1) Upload each image, collecting keys.
      const attachmentKeys: string[] = []
      for (const img of pendingImages) {
        const form = new FormData()
        form.append('file', img.file)
        const { data } = await client.post<UploadResponse>('/uploads', form)
        attachmentKeys.push(data.key)
      }

      // 2) Post the message.
      const { data: created } = await client.post<Message>(
        `/orders/${orderId}/messages`,
        {
          body: body.trim() || undefined,
          kind,
          attachmentKeys: attachmentKeys.length ? attachmentKeys : undefined,
        },
      )

      setMessages((prev) => [...prev, created])
      // Reset composer.
      pendingImages.forEach((p) => URL.revokeObjectURL(p.previewUrl))
      setPendingImages([])
      setBody('')
      setKind('NORMAL')
      refreshOrderMeta()
    } catch {
      setSendError('Не удалось отправить сообщение')
    } finally {
      setSending(false)
    }
  }

  if (loading) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', py: 8 }}>
        <CircularProgress />
      </Box>
    )
  }

  if (error || !order) {
    return (
      <Box>
        <Button startIcon={<ArrowBackIcon />} onClick={() => navigate('/orders')}>
          К заказам
        </Button>
        <Alert severity="error" sx={{ mt: 2 }}>
          {error ?? 'Заказ не найден'}
        </Alert>
      </Box>
    )
  }

  return (
    <Box
      sx={{
        display: 'flex',
        flexDirection: 'row',
        gap: 2,
        flexGrow: 1,
        alignItems: 'stretch',
        // Fill the viewport height under the AppBar so the messenger feels native.
        height: 'calc(100vh - 64px - 48px)',
      }}
    >
      {/* Chat column */}
      <Box
        sx={{
          display: 'flex',
          flexDirection: 'column',
          flexGrow: 1,
          minWidth: 0,
        }}
      >
      {/* Header */}
      <Paper variant="outlined" sx={{ p: 2, mb: 2, borderRadius: 1.5 }}>
        <Stack
          direction={{ xs: 'column', md: 'row' }}
          spacing={2}
          alignItems={{ xs: 'flex-start', md: 'center' }}
          justifyContent="space-between"
        >
          <Stack direction="row" spacing={1.5} alignItems="center">
            <IconButton
              onClick={() => navigate('/orders')}
              size="small"
              sx={{
                bgcolor: `${BRAND.pale}66`,
                '&:hover': { bgcolor: `${BRAND.pale}` },
              }}
            >
              <ArrowBackIcon />
            </IconButton>
            <Box>
              <Stack direction="row" spacing={0.5} alignItems="center">
                <Typography variant="h6" sx={{ fontWeight: 800 }}>
                  Заказ {order.orderNumber}
                </Typography>
                <Tooltip title="Редактировать заказ">
                  <IconButton size="small" onClick={openEdit}>
                    <EditIcon fontSize="small" />
                  </IconButton>
                </Tooltip>
              </Stack>
              <Typography variant="body2" color="text.secondary">
                {order.title || 'Без названия'}
              </Typography>
            </Box>
          </Stack>

          <Stack
            direction={{ xs: 'column', sm: 'row' }}
            spacing={2}
            alignItems={{ xs: 'flex-start', sm: 'center' }}
          >
            <Stack
              direction="row"
              spacing={2}
              sx={{
                px: 2,
                py: 1,
                borderRadius: 1.5,
                bgcolor: `${BRAND.pale}55`,
              }}
            >
              <Box sx={{ textAlign: 'center' }}>
                <Typography variant="h6" sx={{ fontWeight: 800, color: BRAND.deep }}>
                  {metrics?.revisionCount ?? 0}
                </Typography>
                <Typography variant="caption" color="text.secondary">
                  число правок
                </Typography>
              </Box>
              <Box sx={{ textAlign: 'center' }}>
                <Typography variant="h6" sx={{ fontWeight: 800, color: BRAND.deep }}>
                  {formatDuration(metrics?.avgRevisionSeconds)}
                </Typography>
                <Typography variant="caption" color="text.secondary">
                  среднее время правки
                </Typography>
              </Box>
            </Stack>
          </Stack>
        </Stack>
      </Paper>

      {/* Message list */}
      <Paper
        variant="outlined"
        sx={{
          flexGrow: 1,
          overflowY: 'auto',
          p: 2,
          borderRadius: 1.5,
          background: `linear-gradient(180deg, ${BRAND.pale}40, ${BRAND.pale}1a)`,
        }}
      >
        {messages.length === 0 ? (
          <Box
            sx={{
              height: '100%',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <Typography color="text.secondary">
              Сообщений пока нет. Начните переписку.
            </Typography>
          </Box>
        ) : (
          messages.map((m) => (
            <MessageBubble
              key={m.id}
              message={m}
              ownSide={isOwnSide(m.author.id, user?.id)}
              onOpenImage={setLightbox}
              resolvedSeconds={resolutionByRequestId.get(m.id) ?? null}
            />
          ))
        )}
        <div ref={listEndRef} />
      </Paper>

      {/* Composer */}
      <Paper
        variant="outlined"
        onPaste={handlePaste}
        onDragOver={(e) => {
          e.preventDefault()
          setDragOver(true)
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={handleDrop}
        sx={{
          p: 1.5,
          mt: 2,
          borderRadius: 1.5,
          border: dragOver ? '2px dashed' : undefined,
          borderColor: dragOver ? 'primary.main' : undefined,
          bgcolor: dragOver ? `${BRAND.pale}33` : undefined,
        }}
      >
        {sendError && (
          <Alert severity="error" sx={{ mb: 1 }} onClose={() => setSendError(null)}>
            {sendError}
          </Alert>
        )}

        <ToggleButtonGroup
          value={kind}
          exclusive
          size="small"
          onChange={(_, val) => val && setKind(val as MessageKind)}
          sx={{ mb: 1, flexWrap: 'wrap', gap: 0.5 }}
        >
          <ToggleButton value="NORMAL">Обычное</ToggleButton>
          <ToggleButton
            value="REVISION_REQUEST"
            sx={{
              '&.Mui-selected': {
                bgcolor: `${ACCENT.revision}1f`,
                color: ACCENT.revision,
                '&:hover': { bgcolor: `${ACCENT.revision}2e` },
              },
            }}
          >
            Запрос правки
          </ToggleButton>
          <ToggleButton
            value="REVISION_ANSWER"
            sx={{
              '&.Mui-selected': {
                bgcolor: `${ACCENT.resolution}1f`,
                color: ACCENT.resolution,
                '&:hover': { bgcolor: `${ACCENT.resolution}2e` },
              },
            }}
          >
            Правка готова
          </ToggleButton>
        </ToggleButtonGroup>

        {pendingImages.length > 0 && (
          <Stack direction="row" spacing={1} sx={{ flexWrap: 'wrap', mb: 1, gap: 1 }}>
            {pendingImages.map((img) => (
              <Box key={img.id} sx={{ position: 'relative' }}>
                <Box
                  component="img"
                  src={img.previewUrl}
                  alt={img.file.name}
                  sx={{
                    width: 72,
                    height: 72,
                    objectFit: 'cover',
                    borderRadius: 1,
                    border: '1px solid rgba(0,0,0,0.12)',
                  }}
                />
                <IconButton
                  size="small"
                  onClick={() => removePending(img.id)}
                  sx={{
                    position: 'absolute',
                    top: -8,
                    right: -8,
                    bgcolor: 'background.paper',
                    border: '1px solid rgba(0,0,0,0.12)',
                    '&:hover': { bgcolor: 'background.paper' },
                  }}
                >
                  <CloseIcon sx={{ fontSize: 14 }} />
                </IconButton>
              </Box>
            ))}
          </Stack>
        )}

        <Stack direction="row" spacing={1} alignItems="flex-end">
          <Tooltip title="Прикрепить изображения">
            <IconButton onClick={() => fileInputRef.current?.click()}>
              <ImageIcon />
            </IconButton>
          </Tooltip>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            multiple
            hidden
            onChange={(e) => {
              if (e.target.files) addFiles(e.target.files)
              e.target.value = ''
            }}
          />
          <TextField
            placeholder="Напишите сообщение… (можно вставить или перетащить изображение)"
            value={body}
            onChange={(e) => setBody(e.target.value)}
            multiline
            maxRows={6}
            fullWidth
            size="small"
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                e.preventDefault()
                handleSend()
              }
            }}
          />
          <Button
            variant="contained"
            endIcon={
              sending ? (
                <CircularProgress size={16} color="inherit" />
              ) : (
                <SendIcon />
              )
            }
            disabled={!canSend}
            onClick={handleSend}
            sx={{
              color: '#fff',
              '& .MuiButton-endIcon': { color: '#fff' },
              '&.Mui-disabled': { color: 'rgba(255,255,255,0.6)' },
            }}
          >
            Отправить
          </Button>
        </Stack>
      </Paper>
      </Box>

      {/* Right info panel */}
      <OrderInfoPanel
        order={order}
        orderStatusOptions={orderStatusOptions}
        managerAssignees={managerAssignees}
        designerAssignees={designerAssignees}
        canReassignResponsible={canReassignResponsible}
        updatingOrderStatus={updatingOrderStatus}
        updatingResponsible={updatingResponsible}
        onOrderStatusChange={(statusId) => {
          void handleOrderStatusChange(statusId)
        }}
        onResponsibleChange={(field, userId) => {
          void handleResponsibleChange(field, userId)
        }}
      />

      {/* Edit order dialog */}
      <Dialog
        open={editOpen}
        onClose={() => !savingEdit && setEditOpen(false)}
        fullWidth
        maxWidth="sm"
      >
        <DialogTitle>Редактирование заказа</DialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={{ mt: 1 }}>
            {editError && <Alert severity="error">{editError}</Alert>}
            <TextField
              label="Номер заказа"
              value={editNumber}
              onChange={(e) => setEditNumber(e.target.value)}
              required
              fullWidth
              autoFocus
            />
            <TextField
              label="Наименование (необязательно)"
              value={editTitle}
              onChange={(e) => setEditTitle(e.target.value)}
              fullWidth
            />
            <TextField
              select
              label="Менеджер ведения"
              value={editDeliveryManagerId === '' ? '' : String(editDeliveryManagerId)}
              onChange={(e) =>
                setEditDeliveryManagerId(e.target.value ? Number(e.target.value) : '')
              }
              fullWidth
              disabled={!canReassignResponsible}
            >
              <MenuItem value="">Не назначен</MenuItem>
              {editDeliveryManagerId !== '' &&
                !managerAssignees.some((assignee) => assignee.id === editDeliveryManagerId) && (
                  <MenuItem value={String(editDeliveryManagerId)}>
                    {order.deliveryManager?.name ?? `Пользователь #${editDeliveryManagerId}`}
                  </MenuItem>
                )}
              {managerAssignees.map((assignee) => (
                <MenuItem key={assignee.id} value={String(assignee.id)}>
                  {assignee.name}
                </MenuItem>
              ))}
            </TextField>
            <TextField
              select
              label="Менеджер оформления"
              value={editOnboardingManagerId === '' ? '' : String(editOnboardingManagerId)}
              onChange={(e) =>
                setEditOnboardingManagerId(e.target.value ? Number(e.target.value) : '')
              }
              fullWidth
              disabled={!canReassignResponsible}
            >
              <MenuItem value="">Не назначен</MenuItem>
              {editOnboardingManagerId !== '' &&
                !managerAssignees.some((assignee) => assignee.id === editOnboardingManagerId) && (
                  <MenuItem value={String(editOnboardingManagerId)}>
                    {order.onboardingManager?.name ?? `Пользователь #${editOnboardingManagerId}`}
                  </MenuItem>
                )}
              {managerAssignees.map((assignee) => (
                <MenuItem key={assignee.id} value={String(assignee.id)}>
                  {assignee.name}
                </MenuItem>
              ))}
            </TextField>
            <TextField
              select
              label="Художник эскиза"
              value={editSketchDesignerId === '' ? '' : String(editSketchDesignerId)}
              onChange={(e) =>
                setEditSketchDesignerId(e.target.value ? Number(e.target.value) : '')
              }
              fullWidth
              disabled={!canReassignResponsible}
            >
              <MenuItem value="">Не назначен</MenuItem>
              {editSketchDesignerId !== '' &&
                !designerAssignees.some((assignee) => assignee.id === editSketchDesignerId) && (
                  <MenuItem value={String(editSketchDesignerId)}>
                    {order.sketchDesigner?.name ?? `Пользователь #${editSketchDesignerId}`}
                  </MenuItem>
                )}
              {designerAssignees.map((assignee) => (
                <MenuItem key={assignee.id} value={String(assignee.id)}>
                  {assignee.name}
                </MenuItem>
              ))}
            </TextField>
            <TextField
              select
              label="Художник правок"
              value={editRevisionDesignerId === '' ? '' : String(editRevisionDesignerId)}
              onChange={(e) =>
                setEditRevisionDesignerId(e.target.value ? Number(e.target.value) : '')
              }
              fullWidth
              disabled={!canReassignResponsible}
              helperText={
                canReassignResponsible
                  ? 'Назначайте ответственных по ролям'
                  : 'Только просмотр: нужен скоуп на изменение ответственных'
              }
            >
              <MenuItem value="">Не назначен</MenuItem>
              {editRevisionDesignerId !== '' &&
                !designerAssignees.some((assignee) => assignee.id === editRevisionDesignerId) && (
                  <MenuItem value={String(editRevisionDesignerId)}>
                    {order.revisionDesigner?.name ?? `Пользователь #${editRevisionDesignerId}`}
                  </MenuItem>
                )}
              {designerAssignees.map((assignee) => (
                <MenuItem key={assignee.id} value={String(assignee.id)}>
                  {assignee.name}
                </MenuItem>
              ))}
            </TextField>
          </Stack>
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2 }}>
          <Button onClick={() => setEditOpen(false)} disabled={savingEdit}>
            Отмена
          </Button>
          <Button
            variant="contained"
            onClick={handleSaveEdit}
            disabled={savingEdit || !editNumber.trim()}
            startIcon={
              savingEdit ? <CircularProgress size={18} color="inherit" /> : null
            }
          >
            Сохранить
          </Button>
        </DialogActions>
      </Dialog>

      {/* Lightbox */}
      {lightbox && (
        <Box
          onClick={() => setLightbox(null)}
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
          <IconButton
            onClick={() => setLightbox(null)}
            sx={{ position: 'absolute', top: 16, right: 16, color: '#fff' }}
          >
            <CloseIcon />
          </IconButton>
          <Box
            component="img"
            src={lightbox}
            alt="attachment"
            onClick={(e) => e.stopPropagation()}
            sx={{
              maxWidth: '95%',
              maxHeight: '95%',
              objectFit: 'contain',
              borderRadius: 1,
            }}
          />
        </Box>
      )}
    </Box>
  )
}
