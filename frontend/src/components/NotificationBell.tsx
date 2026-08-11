import { useCallback, useEffect, useRef, useState, type MouseEvent } from 'react'
import {
  Badge,
  Box,
  Button,
  CircularProgress,
  Divider,
  Fade,
  IconButton,
  Link as MuiLink,
  Paper,
  Popover,
  Stack,
  Typography,
} from '@mui/material'
import NotificationsIcon from '@mui/icons-material/Notifications'
import ForumOutlinedIcon from '@mui/icons-material/ForumOutlined'
import AssignmentOutlinedIcon from '@mui/icons-material/AssignmentOutlined'
import { Link as RouterLink } from 'react-router-dom'
import client from '../api/client'
import { describeApiError, logApiError } from '../api/errors'
import type {
  AppNotification,
  ChatMessageNotificationPayload,
  NotificationsPage,
  OrderStatusNotificationPayload,
} from '../api/types'
import { BRAND } from '../theme'
import { formatDateTime } from '../utils'
import { useNotifications } from '../notifications/NotificationsContext'

function isChatPayload(
  n: AppNotification,
): n is AppNotification & { payload: ChatMessageNotificationPayload } {
  return n.type === 'CHAT_MESSAGE'
}

function isOrderPayload(
  n: AppNotification,
): n is AppNotification & { payload: OrderStatusNotificationPayload } {
  return n.type === 'ORDER_STATUS'
}

function NotificationRow({ item }: { item: AppNotification }) {
  const read = Boolean(item.readAt)
  return (
    <Box
      sx={{
        px: 1.5,
        py: 1.25,
        opacity: read ? 0.62 : 1,
        bgcolor: read ? 'action.hover' : 'background.paper',
        borderLeft: 3,
        borderColor: read ? 'transparent' : 'primary.main',
      }}
    >
      <Stack direction="row" spacing={1.25} alignItems="flex-start">
        <Box sx={{ color: read ? 'text.disabled' : 'primary.main', mt: 0.25 }}>
          {item.type === 'CHAT_MESSAGE' ? (
            <ForumOutlinedIcon fontSize="small" />
          ) : (
            <AssignmentOutlinedIcon fontSize="small" />
          )}
        </Box>
        <Box sx={{ minWidth: 0, flex: 1 }}>
          {isChatPayload(item) ? (
            <Typography variant="body2" sx={{ fontWeight: read ? 400 : 600 }}>
              Пришло новое сообщение(я) в чате{' '}
              <MuiLink
                component={RouterLink}
                to={`/chats/${item.payload.chatId}`}
                underline="hover"
                color="inherit"
                sx={{ fontWeight: 700 }}
              >
                {item.payload.chatName}
              </MuiLink>
            </Typography>
          ) : isOrderPayload(item) ? (
            <Typography variant="body2" sx={{ fontWeight: read ? 400 : 600 }}>
              Новый заказ{' '}
              <MuiLink
                component={RouterLink}
                to={`/orders/${item.payload.orderId}`}
                underline="hover"
                color="primary"
                sx={{ fontWeight: 700 }}
              >
                {item.payload.orderNumber}
              </MuiLink>{' '}
              в статусе {item.payload.statusName}
            </Typography>
          ) : null}
          <Typography variant="caption" color="text.secondary">
            {formatDateTime(item.createdAt)}
          </Typography>
        </Box>
      </Stack>
    </Box>
  )
}

export default function NotificationBell() {
  const { unreadCount, toasts, dismissToast, markOneRead, markAllRead } = useNotifications()
  const [anchorEl, setAnchorEl] = useState<HTMLElement | null>(null)
  const [items, setItems] = useState<AppNotification[]>([])
  const [nextCursor, setNextCursor] = useState<number | null>(null)
  const [hasMore, setHasMore] = useState(false)
  const [loading, setLoading] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const listRef = useRef<HTMLDivElement | null>(null)
  const sentinelRef = useRef<HTMLDivElement | null>(null)
  const open = Boolean(anchorEl)

  const loadPage = useCallback(async (cursor?: number | null) => {
    const { data } = await client.get<NotificationsPage>('/notifications', {
      params: { limit: 20, ...(cursor ? { cursor } : {}) },
    })
    return data
  }, [])

  const openBell = async (event: MouseEvent<HTMLElement>) => {
    setAnchorEl(event.currentTarget)
    setError(null)
    setLoading(true)
    try {
      void markAllRead()
      const data = await loadPage()
      setItems(data.items.map((item) => ({ ...item, readAt: item.readAt ?? new Date().toISOString() })))
      setNextCursor(data.nextCursor)
      setHasMore(data.hasMore)
    } catch (err) {
      logApiError('загрузка уведомлений', err)
      setError(describeApiError(err, 'Не удалось загрузить уведомления'))
    } finally {
      setLoading(false)
    }
  }

  const closeBell = () => setAnchorEl(null)

  const loadMore = useCallback(async () => {
    if (!hasMore || nextCursor == null || loadingMore) return
    setLoadingMore(true)
    try {
      const data = await loadPage(nextCursor)
      setItems((prev) => [...prev, ...data.items])
      setNextCursor(data.nextCursor)
      setHasMore(data.hasMore)
    } catch (err) {
      logApiError('подгрузка уведомлений', err)
    } finally {
      setLoadingMore(false)
    }
  }, [hasMore, loadPage, loadingMore, nextCursor])

  useEffect(() => {
    if (!open || !sentinelRef.current || !listRef.current) return
    const root = listRef.current
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          void loadMore()
        }
      },
      { root, rootMargin: '40px' },
    )
    observer.observe(sentinelRef.current)
    return () => observer.disconnect()
  }, [loadMore, open, items.length])

  const handleToastRead = async (toastKey: string, notificationId: number) => {
    dismissToast(toastKey)
    try {
      await markOneRead(notificationId)
    } catch (err) {
      logApiError('прочитать уведомление', err)
    }
  }

  return (
    <>
      <Box
        sx={{
          position: 'fixed',
          right: { xs: 16, sm: 24 },
          bottom: { xs: 16, sm: 24 },
          zIndex: (theme) => theme.zIndex.snackbar,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'flex-end',
          gap: 1,
        }}
      >
        <Stack spacing={1} sx={{ width: { xs: 280, sm: 320 }, mb: 0.5 }}>
          {toasts.map((toast) => (
            <Fade key={toast.key} in>
              <Paper
                elevation={6}
                sx={{
                  p: 1.25,
                  borderRadius: 2,
                  border: '1px solid',
                  borderColor: 'divider',
                  bgcolor: 'background.paper',
                }}
              >
                <Stack spacing={1}>
                  {isChatPayload(toast.notification) ? (
                    <Typography variant="body2" sx={{ fontWeight: 600 }}>
                      Новое сообщение(я) в чате {toast.notification.payload.chatName}
                    </Typography>
                  ) : isOrderPayload(toast.notification) ? (
                    <Typography variant="body2" sx={{ fontWeight: 600 }}>
                      Новый заказ {toast.notification.payload.orderNumber} ·{' '}
                      {toast.notification.payload.statusName}
                    </Typography>
                  ) : null}
                  <Stack direction="row" justifyContent="flex-end" spacing={1}>
                    <Button size="small" onClick={() => dismissToast(toast.key)}>
                      Скрыть
                    </Button>
                    <Button
                      size="small"
                      variant="contained"
                      onClick={() => void handleToastRead(toast.key, toast.notification.id)}
                    >
                      Прочитать
                    </Button>
                  </Stack>
                </Stack>
              </Paper>
            </Fade>
          ))}
        </Stack>

        <Badge
          badgeContent={unreadCount > 99 ? '99+' : unreadCount}
          color="error"
          overlap="circular"
          invisible={unreadCount <= 0}
        >
          <IconButton
            onClick={(e) => void openBell(e)}
            aria-label="Уведомления"
            sx={{
              width: 56,
              height: 56,
              bgcolor: BRAND.main,
              color: '#fff',
              boxShadow: 4,
              '&:hover': { bgcolor: BRAND.deep },
            }}
          >
            <NotificationsIcon />
          </IconButton>
        </Badge>
      </Box>

      <Popover
        open={open}
        anchorEl={anchorEl}
        onClose={closeBell}
        anchorOrigin={{ vertical: 'top', horizontal: 'right' }}
        transformOrigin={{ vertical: 'bottom', horizontal: 'right' }}
        slotProps={{
          paper: {
            sx: {
              width: { xs: 320, sm: 380 },
              maxHeight: 440,
              display: 'flex',
              flexDirection: 'column',
              overflow: 'hidden',
              mb: 1,
            },
          },
        }}
      >
        <Box sx={{ px: 2, py: 1.5 }}>
          <Typography variant="subtitle1" sx={{ fontWeight: 800 }}>
            Уведомления
          </Typography>
          <Typography variant="caption" color="text.secondary">
            За последние 3 суток · время МСК
          </Typography>
        </Box>
        <Divider />
        <Box ref={listRef} sx={{ overflowY: 'auto', flex: 1 }}>
          {loading ? (
            <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}>
              <CircularProgress size={28} />
            </Box>
          ) : error ? (
            <Typography color="error" sx={{ p: 2 }} variant="body2">
              {error}
            </Typography>
          ) : items.length === 0 ? (
            <Typography color="text.secondary" sx={{ p: 2 }} variant="body2">
              Пока нет уведомлений
            </Typography>
          ) : (
            <>
              {items.map((item) => (
                <NotificationRow key={item.id} item={item} />
              ))}
              <Box ref={sentinelRef} sx={{ height: 1 }} />
              {loadingMore && (
                <Box sx={{ display: 'flex', justifyContent: 'center', py: 1.5 }}>
                  <CircularProgress size={20} />
                </Box>
              )}
            </>
          )}
        </Box>
      </Popover>
    </>
  )
}
