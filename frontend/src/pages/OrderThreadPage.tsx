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
  Drawer,
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
import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined'
import Inventory2OutlinedIcon from '@mui/icons-material/Inventory2Outlined'
import LocalOfferOutlinedIcon from '@mui/icons-material/LocalOfferOutlined'
import HistoryIcon from '@mui/icons-material/History'
import { AxiosError } from 'axios'
import { useNavigate, useParams } from 'react-router-dom'
import client from '../api/client'
import ImageLightbox, {
  ImageAttachmentPreview,
  type LightboxImage,
} from '../components/ImageLightbox'
import type {
  BluesalesStatusOption,
  BluesalesTag,
  Message,
  MessageKind,
  MessagesPage,
  OrderArticle,
  OrderAssignee,
  Order,
  OrderEvent,
  OrderMetrics,
  UpdateOrderPayload,
  UploadResponse,
} from '../api/types'

const MESSAGES_PAGE_SIZE = 30
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
  sketchDesigners: OrderAssignee[]
  revisionDesigners: OrderAssignee[]
}

const EMPTY_ASSIGNEES: AssigneesResponse = {
  managers: [],
  sketchDesigners: [],
  revisionDesigners: [],
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
  onOpenImage: (image: LightboxImage) => void
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
                  <ImageAttachmentPreview
                    key={att.id}
                    image={{ url: att.url, filename: att.filename }}
                    onOpen={() =>
                      onOpenImage({ url: att.url, filename: att.filename })
                    }
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

// Человекочитаемые подписи полей заказа для системных событий лога.
const EVENT_FIELD_LABELS: Record<string, string> = {
  sketchDesigner: 'художника эскиза',
  revisionDesigner: 'художника правок',
  orderStatus: 'статус заказа',
  crmStatus: 'CRM-статус',
  orderNumber: 'номер заказа',
  title: 'название',
  note: 'примечание',
  dialogLink: 'ссылку на диалог',
}

// Системная запись лога заказа: по центру ленты, «кто что с чего на что поменял».
function SystemEventRow({ event }: { event: OrderEvent }) {
  const label = EVENT_FIELD_LABELS[event.field] ?? event.field
  const actorName = event.actor?.name ?? 'Система'
  const dash = '—'
  const from = event.oldValue?.trim() ? event.oldValue : dash
  const to = event.newValue?.trim() ? event.newValue : dash
  return (
    <Box sx={{ display: 'flex', justifyContent: 'center', my: 1 }}>
      <Paper
        elevation={0}
        sx={{
          px: 1.5,
          py: 0.75,
          borderRadius: 2,
          bgcolor: `${BRAND.pale}66`,
          border: `1px solid ${BRAND.pale}`,
          maxWidth: '92%',
        }}
      >
        <Stack
          direction="row"
          spacing={0.75}
          alignItems="center"
          justifyContent="center"
          sx={{ flexWrap: 'wrap' }}
        >
          <HistoryIcon sx={{ fontSize: 15, color: 'text.secondary' }} />
          <Typography variant="caption" sx={{ color: 'text.secondary', textAlign: 'center' }}>
            <b>{actorName}</b> изменил(а) {label}:{' '}
            <Box component="span" sx={{ textDecoration: 'line-through', opacity: 0.7 }}>
              {from}
            </Box>{' '}
            → <b>{to}</b>
          </Typography>
          <Typography variant="caption" color="text.secondary" sx={{ opacity: 0.6 }}>
            {formatTime(event.createdAt)}
          </Typography>
        </Stack>
      </Paper>
    </Box>
  )
}

function InfoRow({
  label,
  value,
}: {
  label: ReactNode
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
        sx={{ flexShrink: 0, fontSize: '0.84rem' }}
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
  sketchDesignerAssignees,
  revisionDesignerAssignees,
  canReassignResponsible,
  updatingOrderStatus,
  updatingResponsible,
  updatingDialogLink,
  onOrderStatusChange,
  onResponsibleChange,
  onDialogLinkChange,
  inDrawer = false,
}: {
  order: Order
  orderStatusOptions: BluesalesStatusOption[]
  sketchDesignerAssignees: OrderAssignee[]
  revisionDesignerAssignees: OrderAssignee[]
  canReassignResponsible: boolean
  updatingOrderStatus: boolean
  updatingResponsible: boolean
  updatingDialogLink: boolean
  onOrderStatusChange: (statusId: number) => void
  onResponsibleChange: (
    field: 'sketchDesignerId' | 'revisionDesignerId',
    userId: number | '',
  ) => void
  onDialogLinkChange: (dialogLink: string) => void
  inDrawer?: boolean
}) {
  const bs = order.bluesalesInfo
  const lead = order.lead
  const dash = '—'
  const [editingDialogLink, setEditingDialogLink] = useState(false)
  const [dialogLinkDraft, setDialogLinkDraft] = useState(order.dialogLink ?? '')
  const bluesalesCustomerUrl =
    lead?.bsCustomerId != null
      ? `https://bluesales.ru/app/Customers/CustomerView.aspx?id=${lead.bsCustomerId}`
      : null

  useEffect(() => {
    if (!editingDialogLink) {
      setDialogLinkDraft(order.dialogLink ?? '')
    }
  }, [order.dialogLink, editingDialogLink])

  return (
    <Paper
      variant={inDrawer ? 'elevation' : 'outlined'}
      elevation={0}
      sx={
        inDrawer
          ? {
              width: '100%',
              p: 2,
              borderRadius: 0,
              overflowY: 'auto',
            }
          : {
              width: 320,
              flexShrink: 0,
              p: 2,
              borderRadius: 1.5,
              overflowY: 'auto',
              display: { xs: 'none', lg: 'block' },
            }
      }
    >
      <SectionTitle icon={<ReceiptLongIcon fontSize="small" />}>
        Информация о заказе
      </SectionTitle>
      <Stack divider={<Divider flexItem />}>
        <InfoRow label="Номер" value={order.orderNumber} />
        <InfoRow
          label="Менеджер ведения"
          value={order.deliveryManagerName?.trim() ? order.deliveryManagerName : dash}
        />
        <InfoRow
          label="Менеджер оформления"
          value={order.onboardingManagerName?.trim() ? order.onboardingManagerName : dash}
        />
        <Box sx={{ pt: 1.4, pb: 0.6 }}>
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
              sketchDesignerAssignees.length === 0
                ? 'Нет пользователей с ролью художника эскиза'
                : !canReassignResponsible
                  ? 'Только просмотр: нужен скоуп на изменение ответственных'
                  : undefined
            }
          >
            <MenuItem value="">Не назначен</MenuItem>
            {order.sketchDesigner &&
              !sketchDesignerAssignees.some(
                (assignee) => assignee.id === order.sketchDesigner!.id,
              ) && (
                <MenuItem value={String(order.sketchDesigner.id)}>
                  {order.sketchDesigner.name}
                </MenuItem>
              )}
            {sketchDesignerAssignees.map((assignee) => (
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
              revisionDesignerAssignees.length === 0
                ? 'Нет пользователей с ролью художника правок'
                : !canReassignResponsible
                  ? 'Только просмотр: нужен скоуп на изменение ответственных'
                  : undefined
            }
          >
            <MenuItem value="">Не назначен</MenuItem>
            {order.revisionDesigner &&
              !revisionDesignerAssignees.some(
                (assignee) => assignee.id === order.revisionDesigner!.id,
              ) && (
                <MenuItem value={String(order.revisionDesigner.id)}>
                  {order.revisionDesigner.name}
                </MenuItem>
              )}
            {revisionDesignerAssignees.map((assignee) => (
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
            <Box sx={{ py: 0.4 }}>
              <Stack direction="row" spacing={1} justifyContent="space-between" alignItems="center">
                <Typography variant="caption" color="text.secondary" sx={{ flexShrink: 0 }}>
                  Диалог BS
                </Typography>
                {editingDialogLink ? (
                  <Stack direction="row" spacing={0.25} alignItems="center">
                    <TextField
                      size="small"
                      value={dialogLinkDraft}
                      placeholder="Вставьте ссылку"
                      onChange={(e) => setDialogLinkDraft(e.target.value)}
                      disabled={updatingDialogLink}
                      sx={{ minWidth: 168 }}
                    />
                    <Button
                      size="small"
                      onClick={() => {
                        onDialogLinkChange(dialogLinkDraft)
                        setEditingDialogLink(false)
                      }}
                      disabled={updatingDialogLink}
                      sx={{ minWidth: 40, px: 1 }}
                    >
                      OK
                    </Button>
                    <Button
                      size="small"
                      color="inherit"
                      onClick={() => {
                        setDialogLinkDraft(order.dialogLink ?? '')
                        setEditingDialogLink(false)
                      }}
                      disabled={updatingDialogLink}
                      sx={{ minWidth: 56, px: 1 }}
                    >
                      Отмена
                    </Button>
                  </Stack>
                ) : (
                  <Stack
                    direction="row"
                    spacing={0.25}
                    alignItems="center"
                    justifyContent="flex-end"
                    sx={{ minWidth: 0, flex: 1 }}
                  >
                    {order.dialogLink ? (
                      <Link
                        href={order.dialogLink}
                        target="_blank"
                        rel="noopener noreferrer"
                        underline="hover"
                        title={order.dialogLink}
                        sx={{
                          minWidth: 0,
                          maxWidth: '100%',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                          display: 'block',
                          fontWeight: 700,
                        }}
                      >
                        {order.dialogLink}
                      </Link>
                    ) : (
                      <Typography
                        variant="body2"
                        component="span"
                        color="text.secondary"
                        sx={{
                          minWidth: 0,
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                          fontWeight: 600,
                        }}
                      >
                        Ссылка не добавлена
                      </Typography>
                    )}
                    <Tooltip title="Редактировать ссылку">
                      <IconButton
                        size="small"
                        onClick={() => setEditingDialogLink(true)}
                        sx={{
                          ml: 0.25,
                          p: 0.5,
                          color: 'text.secondary',
                          '&:hover': { color: 'text.primary' },
                        }}
                      >
                        <EditIcon sx={{ fontSize: 18 }} />
                      </IconButton>
                    </Tooltip>
                  </Stack>
                )}
              </Stack>
            </Box>
            <Box sx={{ py: 1.2 }}>
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
              {order.orderStatusSync && (
                <Alert
                  severity={
                    order.orderStatusSync.state === 'failed'
                      ? 'error'
                      : order.orderStatusSync.state === 'retrying'
                        ? 'warning'
                        : 'info'
                  }
                  sx={{ mt: 1 }}
                >
                  {order.orderStatusSync.state === 'failed'
                    ? 'Отправка прекращена: заказ удалён или недоступен в BlueSales.'
                    : order.orderStatusSync.state === 'retrying'
                    ? `BlueSales пока не принял статус. Автоматический повтор №${order.orderStatusSync.attempts}.`
                    : 'Статус сохранён. Отправляется в BlueSales.'}
                  {order.orderStatusSync.lastError
                    ? ` ${order.orderStatusSync.lastError}`
                    : ''}
                </Alert>
              )}
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
            <InfoRow
              label="ID клиента в BS"
              value={
                bluesalesCustomerUrl ? (
                  <Link
                    href={bluesalesCustomerUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    sx={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 0.5,
                      fontWeight: 700,
                    }}
                  >
                    {lead.vkUserId ?? String(lead.bsCustomerId)}
                    <OpenInNewIcon sx={{ fontSize: 15 }} />
                  </Link>
                ) : (
                  lead.vkUserId ?? dash
                )
              }
            />
            <InfoRow label="CRM-статус" value={lead.crmStatus ?? dash} />
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

function OrderArticlesPanel({
  articles,
  tags,
  noteDraft,
  savingNote,
  onNoteDraftChange,
  onSaveNote,
  inDrawer = false,
}: {
  articles: OrderArticle[]
  tags: BluesalesTag[]
  noteDraft: string
  savingNote: boolean
  onNoteDraftChange: (value: string) => void
  onSaveNote: () => void
  inDrawer?: boolean
}) {
  return (
    <Paper
      variant={inDrawer ? 'elevation' : 'outlined'}
      elevation={0}
      sx={
        inDrawer
          ? {
              width: '100%',
              p: 2,
              borderRadius: 0,
              overflowY: 'auto',
            }
          : {
              width: 300,
              flexShrink: 0,
              p: 2,
              borderRadius: 1.5,
              overflowY: 'auto',
              display: { xs: 'none', lg: 'block' },
            }
      }
    >
      <SectionTitle icon={<Inventory2OutlinedIcon fontSize="small" />}>
        Артикулы заказа
      </SectionTitle>
      {articles.length === 0 ? (
        <Typography variant="body2" color="text.secondary">
          Артикулы не найдены
        </Typography>
      ) : (
        <Stack divider={<Divider flexItem />} spacing={0}>
          {articles.map((item, index) => (
            <Stack
              key={`${item.article ?? 'noart'}-${index}`}
              direction="row"
              spacing={1}
              alignItems="flex-start"
              justifyContent="space-between"
              sx={{ py: 0.8 }}
            >
              <Box sx={{ minWidth: 0 }}>
                <Typography
                  variant="body2"
                  sx={{ fontWeight: 700, fontFamily: 'monospace', wordBreak: 'break-word' }}
                >
                  {item.article ?? '—'}
                </Typography>
                {item.name && (
                  <Typography
                    variant="caption"
                    color="text.secondary"
                    sx={{ display: 'block', wordBreak: 'break-word' }}
                  >
                    {item.name}
                  </Typography>
                )}
              </Box>
              {item.quantity != null && (
                <Chip
                  size="small"
                  label={`×${item.quantity.toLocaleString('ru-RU')}`}
                  sx={{ flexShrink: 0, fontWeight: 700, bgcolor: `${BRAND.pale}99` }}
                />
              )}
            </Stack>
          ))}
        </Stack>
      )}
      <Divider sx={{ my: 2 }} />
      <SectionTitle icon={<LocalOfferOutlinedIcon fontSize="small" />}>
        Теги клиента
      </SectionTitle>
      {tags.length === 0 ? (
        <Typography variant="body2" color="text.secondary">
          Теги не найдены
        </Typography>
      ) : (
        <Stack direction="row" useFlexGap flexWrap="wrap" gap={0.75}>
          {tags.map((tag) => (
            <Chip
              key={tag.id}
              size="small"
              label={tag.name}
              title={`BlueSales tag ID: ${tag.id}`}
              sx={{
                bgcolor:
                  tag.name.trim().toLocaleLowerCase('ru-RU') === 'срочно'
                    ? 'error.main'
                    : 'primary.main',
                color: '#fff',
                fontWeight: 700,
              }}
            />
          ))}
        </Stack>
      )}
      <Divider sx={{ my: 2 }} />
      <SectionTitle icon={<EditNoteIcon fontSize="small" />}>Примечание</SectionTitle>
      <TextField
        value={noteDraft}
        onChange={(event) => onNoteDraftChange(event.target.value)}
        placeholder="Добавьте примечание к заказу"
        multiline
        minRows={3}
        maxRows={8}
        fullWidth
        size="small"
        disabled={savingNote}
        inputProps={{ maxLength: 5000 }}
      />
      <Button
        variant="contained"
        size="small"
        fullWidth
        onClick={onSaveNote}
        disabled={savingNote}
        sx={{ mt: 1 }}
      >
        {savingNote ? 'Сохранение…' : 'Сохранить примечание'}
      </Button>
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
  const [sketchDesignerAssignees, setSketchDesignerAssignees] = useState<OrderAssignee[]>([])
  const [revisionDesignerAssignees, setRevisionDesignerAssignees] = useState<OrderAssignee[]>([])
  const [metrics, setMetrics] = useState<OrderMetrics | null>(null)
  const [messages, setMessages] = useState<Message[]>([])
  const [events, setEvents] = useState<OrderEvent[]>([])
  const [loading, setLoading] = useState(true)
  const [loadingOlder, setLoadingOlder] = useState(false)
  const [hasMore, setHasMore] = useState(false)
  const [nextCursor, setNextCursor] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)

  const [body, setBody] = useState('')
  const [kind, setKind] = useState<MessageKind>('NORMAL')
  const [pendingImages, setPendingImages] = useState<PendingImage[]>([])
  const [sending, setSending] = useState(false)
  const [sendError, setSendError] = useState<string | null>(null)
  const [dragOver, setDragOver] = useState(false)
  const [lightbox, setLightbox] = useState<LightboxImage | null>(null)
  const [infoOpen, setInfoOpen] = useState(false)

  const [editOpen, setEditOpen] = useState(false)
  const [editNumber, setEditNumber] = useState('')
  const [editTitle, setEditTitle] = useState('')
  const [editDialogLink, setEditDialogLink] = useState('')
  const [editSketchDesignerId, setEditSketchDesignerId] = useState<number | ''>('')
  const [editRevisionDesignerId, setEditRevisionDesignerId] = useState<number | ''>('')
  const [savingEdit, setSavingEdit] = useState(false)
  const [editError, setEditError] = useState<string | null>(null)
  const [updatingOrderStatus, setUpdatingOrderStatus] = useState(false)
  const [updatingResponsible, setUpdatingResponsible] = useState(false)
  const [updatingDialogLink, setUpdatingDialogLink] = useState(false)
  const [noteDraft, setNoteDraft] = useState('')
  const [savingNote, setSavingNote] = useState(false)

  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const listEndRef = useRef<HTMLDivElement | null>(null)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const loadingOlderRef = useRef(false)
  const pendingScrollBottomRef = useRef(true)
  const canReassignResponsible = canEditOrderResponsibles(user?.role, user?.scopes)

  const loadAll = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const [orderRes, metricsRes, messagesRes, eventsRes, statusesRes, assigneesRes] =
        await Promise.all([
          client.get<Order>(`/orders/${orderId}`),
          client.get<OrderMetrics>(`/orders/${orderId}/metrics`),
          client.get<MessagesPage<Message>>(`/orders/${orderId}/messages`, {
            params: { limit: MESSAGES_PAGE_SIZE },
          }),
          client.get<OrderEvent[]>(`/orders/${orderId}/events`),
          client.get<BluesalesStatusOption[]>('/orders/order-statuses'),
          canReassignResponsible
            ? client.get<AssigneesResponse>('/orders/assignees')
            : Promise.resolve({ data: EMPTY_ASSIGNEES }),
        ])
      setOrder(orderRes.data)
      setNoteDraft(orderRes.data.note ?? '')
      setMetrics(metricsRes.data)
      setMessages(messagesRes.data.items)
      setEvents(eventsRes.data)
      setNextCursor(messagesRes.data.nextCursor)
      setHasMore(messagesRes.data.hasMore)
      pendingScrollBottomRef.current = true
      setOrderStatuses(statusesRes.data)
      setSketchDesignerAssignees(assigneesRes.data.sketchDesigners)
      setRevisionDesignerAssignees(assigneesRes.data.revisionDesigners)
    } catch {
      setError('Не удалось загрузить заказ')
    } finally {
      setLoading(false)
    }
  }, [canReassignResponsible, orderId])

  const refreshEvents = useCallback(async () => {
    try {
      const { data } = await client.get<OrderEvent[]>(`/orders/${orderId}/events`)
      setEvents(data)
    } catch {
      /* лог событий не критичен */
    }
  }, [orderId])

  const loadOlder = useCallback(async () => {
    if (loadingOlderRef.current || !hasMore || nextCursor == null) return
    loadingOlderRef.current = true
    setLoadingOlder(true)
    const container = scrollRef.current
    const prevHeight = container?.scrollHeight ?? 0
    const prevTop = container?.scrollTop ?? 0
    try {
      const { data } = await client.get<MessagesPage<Message>>(
        `/orders/${orderId}/messages`,
        { params: { limit: MESSAGES_PAGE_SIZE, before: nextCursor } },
      )
      setMessages((prev) => {
        const existing = new Set(prev.map((m) => m.id))
        const older = data.items.filter((m) => !existing.has(m.id))
        return [...older, ...prev]
      })
      setNextCursor(data.nextCursor)
      setHasMore(data.hasMore)
      requestAnimationFrame(() => {
        const c = scrollRef.current
        if (c) {
          c.scrollTop = c.scrollHeight - prevHeight + prevTop
        }
      })
    } catch {
      /* подгрузка истории не критична */
    } finally {
      setLoadingOlder(false)
      loadingOlderRef.current = false
    }
  }, [orderId, hasMore, nextCursor])

  const handleScroll = useCallback(() => {
    const container = scrollRef.current
    if (!container) return
    if (container.scrollTop <= 80 && hasMore && !loadingOlderRef.current) {
      void loadOlder()
    }
  }, [hasMore, loadOlder])

  useEffect(() => {
    if (Number.isFinite(orderId)) {
      loadAll()
    }
  }, [orderId, loadAll])

  // Auto-scroll to bottom only on initial load or when a new message is appended.
  useEffect(() => {
    if (pendingScrollBottomRef.current) {
      listEndRef.current?.scrollIntoView({ behavior: 'auto' })
      pendingScrollBottomRef.current = false
    }
  }, [messages])

  const refreshOrderMeta = useCallback(async () => {
    try {
      const [orderRes, metricsRes, eventsRes] = await Promise.all([
        client.get<Order>(`/orders/${orderId}`),
        client.get<OrderMetrics>(`/orders/${orderId}/metrics`),
        client.get<OrderEvent[]>(`/orders/${orderId}/events`),
      ])
      setOrder(orderRes.data)
      setMetrics(metricsRes.data)
      setEvents(eventsRes.data)
    } catch {
      /* non-critical */
    }
  }, [orderId])

  useEffect(() => {
    if (!order?.orderStatusSync || order.orderStatusSync.state === 'failed') return
    let cancelled = false
    let timer: number | undefined
    const poll = async () => {
      await refreshOrderMeta()
      if (!cancelled) timer = window.setTimeout(poll, 2000)
    }
    timer = window.setTimeout(poll, 2000)
    return () => {
      cancelled = true
      if (timer !== undefined) window.clearTimeout(timer)
    }
  }, [order?.orderStatusSync, refreshOrderMeta])

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
      orderStatusSync: {
        state: 'pending',
        attempts: 0,
        lastError: null,
      },
    })
    try {
      const { data } = await client.patch<Order>(`/orders/${orderId}/order-status`, {
        statusId,
      })
      setOrder(data)
      void refreshEvents()
    } catch {
      setOrder(prev)
      setSendError('Не удалось изменить статус заказа')
    } finally {
      setUpdatingOrderStatus(false)
    }
  }

  const handleResponsibleChange = async (
    field: 'sketchDesignerId' | 'revisionDesignerId',
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
      void refreshEvents()
    } catch {
      setSendError('Не удалось изменить ответственного')
    } finally {
      setUpdatingResponsible(false)
    }
  }

  const handleDialogLinkChange = async (dialogLink: string) => {
    if (!order) return
    setUpdatingDialogLink(true)
    try {
      const { data } = await client.patch<Order>(`/orders/${orderId}`, {
        dialogLink: dialogLink.trim() ? dialogLink.trim() : null,
      })
      setOrder(data)
      void refreshEvents()
    } catch {
      setSendError('Не удалось сохранить поле "Даилог BS"')
    } finally {
      setUpdatingDialogLink(false)
    }
  }

  const handleSaveNote = async () => {
    if (!order) return
    setSavingNote(true)
    try {
      const { data } = await client.patch<Order>(`/orders/${orderId}`, {
        note: noteDraft.trim() ? noteDraft.trim() : null,
      } satisfies UpdateOrderPayload)
      setOrder(data)
      setNoteDraft(data.note ?? '')
      void refreshEvents()
    } catch {
      setSendError('Не удалось сохранить примечание')
    } finally {
      setSavingNote(false)
    }
  }

  const openEdit = () => {
    if (!order) return
    setEditNumber(order.orderNumber)
    setEditTitle(order.title || '')
    setEditDialogLink(order.dialogLink ?? '')
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
        dialogLink: editDialogLink.trim() ? editDialogLink.trim() : null,
        ...(canReassignResponsible
          ? {
              sketchDesignerId: editSketchDesignerId === '' ? null : editSketchDesignerId,
              revisionDesignerId:
                editRevisionDesignerId === '' ? null : editRevisionDesignerId,
            }
          : {}),
      }
      const { data } = await client.patch<Order>(`/orders/${orderId}`, payload)
      setOrder(data)
      void refreshEvents()
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

  // Есть ли незакрытая правка: запрос правки, на который ещё нет ответа.
  // Пока такая правка открыта, нельзя отправлять новый запрос правки.
  const hasOpenRevision = useMemo(() => {
    const answeredRequestIds = new Set<number>()
    for (const m of messages) {
      if (m.kind === 'REVISION_ANSWER' && m.answerToId != null) {
        answeredRequestIds.add(m.answerToId)
      }
    }
    return messages.some(
      (m) => m.kind === 'REVISION_REQUEST' && !answeredRequestIds.has(m.id),
    )
  }, [messages])

  // Мягко возвращаем режим к обычному сообщению, если выбранный режим больше
  // недоступен: «Запрос правки» — когда правка уже открыта, «Правка готова» —
  // когда закрывать нечего (иначе получилось бы два закрытия подряд).
  useEffect(() => {
    if (hasOpenRevision && kind === 'REVISION_REQUEST') {
      setKind('NORMAL')
    } else if (!hasOpenRevision && kind === 'REVISION_ANSWER') {
      setKind('NORMAL')
    }
  }, [hasOpenRevision, kind])

  // Единая лента: сообщения + системные события, отсортированные по времени.
  // События вне загруженного окна сообщений (когда есть ещё более старые
  // сообщения) скрываем, чтобы они не «висели» вверху без контекста —
  // они появятся по мере подгрузки истории.
  const timeline = useMemo(() => {
    type TimelineItem =
      | { type: 'message'; key: string; at: number; message: Message }
      | { type: 'event'; key: string; at: number; event: OrderEvent }

    const items: TimelineItem[] = messages.map((m) => ({
      type: 'message',
      key: `m-${m.id}`,
      at: new Date(m.createdAt).getTime(),
      message: m,
    }))

    const oldestLoadedAt = messages.length
      ? new Date(messages[0].createdAt).getTime()
      : null

    for (const e of events) {
      const at = new Date(e.createdAt).getTime()
      if (hasMore && oldestLoadedAt != null && at < oldestLoadedAt) continue
      items.push({ type: 'event', key: `e-${e.id}`, at, event: e })
    }

    items.sort((a, b) => {
      if (a.at !== b.at) return a.at - b.at
      // При равном времени показываем сообщение раньше вызванного им события.
      if (a.type === b.type) return 0
      return a.type === 'message' ? -1 : 1
    })
    return items
  }, [messages, events, hasMore])

  const canSend = useMemo(
    () =>
      (body.trim().length > 0 || pendingImages.length > 0) &&
      !sending &&
      !(kind === 'REVISION_REQUEST' && hasOpenRevision) &&
      !(kind === 'REVISION_ANSWER' && !hasOpenRevision),
    [body, pendingImages.length, sending, kind, hasOpenRevision],
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

      pendingScrollBottomRef.current = true
      setMessages((prev) => [...prev, created])
      // Reset composer.
      pendingImages.forEach((p) => URL.revokeObjectURL(p.previewUrl))
      setPendingImages([])
      setBody('')
      setKind('NORMAL')
      refreshOrderMeta()
    } catch (err) {
      const axiosErr = err as AxiosError<{ message?: string | string[] }>
      const serverMessage = axiosErr?.response?.data?.message
      setSendError(
        axiosErr?.response?.status === 400 && serverMessage
          ? Array.isArray(serverMessage)
            ? serverMessage.join(', ')
            : serverMessage
          : 'Не удалось отправить сообщение',
      )
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
        // AppBar is 56px on mobile / 64px from sm up; container padding differs too.
        height: {
          xs: 'calc(100dvh - 56px - 32px)',
          sm: 'calc(100vh - 64px - 48px)',
        },
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
            direction={{ xs: 'row', sm: 'row' }}
            spacing={2}
            alignItems="center"
            sx={{ width: { xs: '100%', md: 'auto' } }}
            justifyContent={{ xs: 'space-between', md: 'flex-end' }}
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

            <Tooltip title="Информация и артикулы заказа">
              <IconButton
                onClick={() => setInfoOpen(true)}
                sx={{
                  display: { xs: 'inline-flex', lg: 'none' },
                  bgcolor: `${BRAND.pale}66`,
                  '&:hover': { bgcolor: `${BRAND.pale}` },
                }}
              >
                <InfoOutlinedIcon />
              </IconButton>
            </Tooltip>
          </Stack>
        </Stack>
      </Paper>

      {/* Message list */}
      <Paper
        ref={scrollRef}
        onScroll={handleScroll}
        variant="outlined"
        sx={{
          flexGrow: 1,
          overflowY: 'auto',
          p: 2,
          borderRadius: 1.5,
          background: `linear-gradient(180deg, ${BRAND.pale}40, ${BRAND.pale}1a)`,
        }}
      >
        {hasMore && (
          <Box sx={{ display: 'flex', justifyContent: 'center', py: 1 }}>
            {loadingOlder ? (
              <CircularProgress size={20} />
            ) : (
              <Button size="small" onClick={() => void loadOlder()}>
                Загрузить ещё
              </Button>
            )}
          </Box>
        )}
        {timeline.length === 0 ? (
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
          timeline.map((item) =>
            item.type === 'message' ? (
              <MessageBubble
                key={item.key}
                message={item.message}
                ownSide={isOwnSide(item.message.author.id, user?.id)}
                onOpenImage={setLightbox}
                resolvedSeconds={resolutionByRequestId.get(item.message.id) ?? null}
              />
            ) : (
              <SystemEventRow key={item.key} event={item.event} />
            ),
          )
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
          <Tooltip
            title={
              hasOpenRevision
                ? 'По заказу уже есть незакрытая правка — дождитесь её закрытия'
                : ''
            }
          >
            <span>
              <ToggleButton
                value="REVISION_REQUEST"
                disabled={hasOpenRevision}
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
            </span>
          </Tooltip>
          <Tooltip
            title={
              !hasOpenRevision
                ? 'Нет открытой правки — закрывать нечего'
                : ''
            }
          >
            <span>
              <ToggleButton
                value="REVISION_ANSWER"
                disabled={!hasOpenRevision}
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
            </span>
          </Tooltip>
        </ToggleButtonGroup>

        {hasOpenRevision && (
          <Alert severity="info" icon={<InfoOutlinedIcon fontSize="small" />} sx={{ mb: 1 }}>
            По заказу уже есть незакрытая правка. Новый запрос правки создать нельзя, пока
            текущая не закрыта. Если появились новые детали — отредактируйте существующий
            запрос правки или отправьте обычное сообщение (без пометок).
          </Alert>
        )}

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
              flexShrink: 0,
              minWidth: { xs: 0, sm: 'auto' },
              px: { xs: 1.5, sm: 2.25 },
              '& .MuiButton-endIcon': {
                color: '#fff',
                ml: { xs: 0, sm: 1 },
              },
              '&.Mui-disabled': { color: 'rgba(255,255,255,0.6)' },
            }}
          >
            <Box component="span" sx={{ display: { xs: 'none', sm: 'inline' } }}>
              Отправить
            </Box>
          </Button>
        </Stack>
      </Paper>
      </Box>

      {/* Right info panel (desktop) */}
      <OrderInfoPanel
        order={order}
        orderStatusOptions={orderStatusOptions}
        sketchDesignerAssignees={sketchDesignerAssignees}
        revisionDesignerAssignees={revisionDesignerAssignees}
        canReassignResponsible={canReassignResponsible}
        updatingOrderStatus={updatingOrderStatus}
        updatingResponsible={updatingResponsible}
        updatingDialogLink={updatingDialogLink}
        onOrderStatusChange={(statusId) => {
          void handleOrderStatusChange(statusId)
        }}
        onResponsibleChange={(field, userId) => {
          void handleResponsibleChange(field, userId)
        }}
        onDialogLinkChange={(dialogLink) => {
          void handleDialogLinkChange(dialogLink)
        }}
      />

      {/* Right articles panel (desktop) */}
      <OrderArticlesPanel
        articles={order.articles ?? []}
        tags={order.lead?.tags ?? []}
        noteDraft={noteDraft}
        savingNote={savingNote}
        onNoteDraftChange={setNoteDraft}
        onSaveNote={() => {
          void handleSaveNote()
        }}
      />

      {/* Info + articles panels as a drawer (mobile / tablet) */}
      <Drawer
        anchor="right"
        open={infoOpen}
        onClose={() => setInfoOpen(false)}
        sx={{ display: { xs: 'block', lg: 'none' } }}
        PaperProps={{ sx: { width: { xs: '88%', sm: 360 }, maxWidth: 420 } }}
      >
        <OrderInfoPanel
          inDrawer
          order={order}
          orderStatusOptions={orderStatusOptions}
          sketchDesignerAssignees={sketchDesignerAssignees}
          revisionDesignerAssignees={revisionDesignerAssignees}
          canReassignResponsible={canReassignResponsible}
          updatingOrderStatus={updatingOrderStatus}
          updatingResponsible={updatingResponsible}
          updatingDialogLink={updatingDialogLink}
          onOrderStatusChange={(statusId) => {
            void handleOrderStatusChange(statusId)
          }}
          onResponsibleChange={(field, userId) => {
            void handleResponsibleChange(field, userId)
          }}
          onDialogLinkChange={(dialogLink) => {
            void handleDialogLinkChange(dialogLink)
          }}
        />
        <Divider />
        <OrderArticlesPanel
          inDrawer
          articles={order.articles ?? []}
          tags={order.lead?.tags ?? []}
          noteDraft={noteDraft}
          savingNote={savingNote}
          onNoteDraftChange={setNoteDraft}
          onSaveNote={() => {
            void handleSaveNote()
          }}
        />
      </Drawer>

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
              label="Даилог BS (ссылка)"
              value={editDialogLink}
              onChange={(e) => setEditDialogLink(e.target.value)}
              fullWidth
            />
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
                !sketchDesignerAssignees.some(
                  (assignee) => assignee.id === editSketchDesignerId,
                ) && (
                  <MenuItem value={String(editSketchDesignerId)}>
                    {order.sketchDesigner?.name ?? `Пользователь #${editSketchDesignerId}`}
                  </MenuItem>
                )}
              {sketchDesignerAssignees.map((assignee) => (
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
                !revisionDesignerAssignees.some(
                  (assignee) => assignee.id === editRevisionDesignerId,
                ) && (
                  <MenuItem value={String(editRevisionDesignerId)}>
                    {order.revisionDesigner?.name ?? `Пользователь #${editRevisionDesignerId}`}
                  </MenuItem>
                )}
              {revisionDesignerAssignees.map((assignee) => (
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
        <ImageLightbox image={lightbox} onClose={() => setLightbox(null)} />
      )}
    </Box>
  )
}
