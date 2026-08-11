import NotificationBell from './NotificationBell'
import { useAuth } from '../auth/AuthContext'

/**
 * Колокольчик вне AppLayout: иначе при смене роута layout размонтируется
 * вместе с открытым Popover и виджет «залипает» / дёргается.
 */
export default function NotificationBellHost() {
  const { token } = useAuth()
  if (!token) return null
  return <NotificationBell />
}
