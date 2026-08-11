import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { io, type Socket } from 'socket.io-client'
import client from '../api/client'
import { logApiError } from '../api/errors'
import type { AppNotification } from '../api/types'
import { useAuth } from '../auth/AuthContext'
import { useUnreadTabIndicator } from './useUnreadTabIndicator'

type ToastItem = {
  key: string
  notification: AppNotification
}

type NotificationsContextValue = {
  unreadCount: number
  toasts: ToastItem[]
  dismissToast: (key: string) => void
  markOneRead: (notificationId: number) => Promise<void>
  markAllRead: () => Promise<void>
  setUnreadCount: (count: number) => void
}

const NotificationsContext = createContext<NotificationsContextValue | null>(null)

export function NotificationsProvider({ children }: { children: ReactNode }) {
  const { token } = useAuth()
  const [unreadCount, setUnreadCount] = useState(0)
  const [toasts, setToasts] = useState<ToastItem[]>([])
  const socketRef = useRef<Socket | null>(null)
  const toastTimersRef = useRef<Map<string, number>>(new Map())

  useUnreadTabIndicator(token ? unreadCount : 0)

  const dismissToast = useCallback((key: string) => {
    setToasts((prev) => prev.filter((item) => item.key !== key))
    const timer = toastTimersRef.current.get(key)
    if (timer != null) {
      window.clearTimeout(timer)
      toastTimersRef.current.delete(key)
    }
  }, [])

  const pushToast = useCallback(
    (notification: AppNotification) => {
      const key = `${notification.id}-${Date.now()}`
      setToasts((prev) => [{ key, notification }, ...prev].slice(0, 2))
      const timer = window.setTimeout(() => {
        dismissToast(key)
      }, 4000)
      toastTimersRef.current.set(key, timer)
    },
    [dismissToast],
  )

  useEffect(() => {
    if (!token) {
      setUnreadCount(0)
      setToasts([])
      return
    }

    let cancelled = false
    void client
      .get<{ count: number }>('/notifications/unread-count')
      .then(({ data }) => {
        if (!cancelled) setUnreadCount(data.count)
      })
      .catch((err) => logApiError('unread notifications count', err))

    const socket = io('/', {
      path: '/socket.io',
      transports: ['websocket'],
      auth: { token },
    })
    socketRef.current = socket

    const onCreated = (payload: {
      notification: AppNotification
      unreadCount: number
    }) => {
      setUnreadCount(payload.unreadCount)
      pushToast(payload.notification)
    }
    const onCount = (payload: { count: number }) => {
      setUnreadCount(payload.count)
    }

    socket.on('notification:created', onCreated)
    socket.on('notification:count', onCount)
    socket.on('connect_error', (err: Error) => {
      console.error(`[socket] notifications: ${err.message}`)
    })

    return () => {
      cancelled = true
      socket.off('notification:created', onCreated)
      socket.off('notification:count', onCount)
      socket.disconnect()
      socketRef.current = null
      for (const timer of toastTimersRef.current.values()) {
        window.clearTimeout(timer)
      }
      toastTimersRef.current.clear()
    }
  }, [pushToast, token])

  const markOneRead = useCallback(async (notificationId: number) => {
    const { data } = await client.post<{ ok: boolean; count: number }>(
      `/notifications/${notificationId}/read`,
    )
    setUnreadCount(data.count)
  }, [])

  const markAllRead = useCallback(async () => {
    setUnreadCount(0)
    await client.post('/notifications/read')
  }, [])

  const value = useMemo(
    () => ({
      unreadCount,
      toasts,
      dismissToast,
      markOneRead,
      markAllRead,
      setUnreadCount,
    }),
    [dismissToast, markAllRead, markOneRead, toasts, unreadCount],
  )

  return (
    <NotificationsContext.Provider value={value}>
      {children}
    </NotificationsContext.Provider>
  )
}

export function useNotifications() {
  const ctx = useContext(NotificationsContext)
  if (!ctx) {
    throw new Error('useNotifications must be used within NotificationsProvider')
  }
  return ctx
}
