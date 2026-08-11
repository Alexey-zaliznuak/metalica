import { useEffect, useRef } from 'react'
import { BRAND } from '../theme'

const BASE_TITLE = 'Металлити — заказы и правки'
const ICON_LINK_ID = 'app-favicon'

function ensureIconLink(): HTMLLinkElement {
  let link = document.getElementById(ICON_LINK_ID) as HTMLLinkElement | null
  if (!link) {
    link = document.createElement('link')
    link.id = ICON_LINK_ID
    link.rel = 'icon'
    link.type = 'image/png'
    document.head.appendChild(link)
  }
  return link
}

/** Синий квадрат с «М»; при unread — красный бейдж с числом. */
function drawFavicon(unreadCount: number, emphasizeBadge = false): string {
  const size = 64
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')
  if (!ctx) return ''

  const radius = 14
  ctx.fillStyle = BRAND.main
  ctx.beginPath()
  ctx.moveTo(radius, 0)
  ctx.arcTo(size, 0, size, size, radius)
  ctx.arcTo(size, size, 0, size, radius)
  ctx.arcTo(0, size, 0, 0, radius)
  ctx.arcTo(0, 0, size, 0, radius)
  ctx.closePath()
  ctx.fill()

  ctx.fillStyle = '#ffffff'
  ctx.font = 'bold 36px Inter, system-ui, sans-serif'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText('М', size / 2, size / 2 + 1)

  if (unreadCount > 0) {
    const badgeR = emphasizeBadge ? 18 : 16
    const cx = size - badgeR + 2
    const cy = badgeR - 2

    ctx.beginPath()
    ctx.arc(cx, cy, badgeR + 2, 0, Math.PI * 2)
    ctx.fillStyle = BRAND.main
    ctx.fill()

    ctx.beginPath()
    ctx.arc(cx, cy, badgeR, 0, Math.PI * 2)
    ctx.fillStyle = emphasizeBadge ? '#FF1744' : '#E53935'
    ctx.fill()

    ctx.fillStyle = '#ffffff'
    ctx.font = `bold ${unreadCount > 9 ? 18 : 22}px Inter, system-ui, sans-serif`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    const label = unreadCount > 99 ? '99+' : unreadCount > 9 ? '9+' : String(unreadCount)
    ctx.fillText(label, cx, cy + 1)
  }

  return canvas.toDataURL('image/png')
}

/**
 * Обновляет favicon и title вкладки при непрочитанных уведомлениях.
 * При росте счётчика — короткий «пульс» бейджа (без бесконечной анимации).
 */
export function useUnreadTabIndicator(unreadCount: number) {
  const prevCountRef = useRef(0)
  const pulseTimerRef = useRef<number | null>(null)

  useEffect(() => {
    const link = ensureIconLink()
    const count = Math.max(0, Math.floor(unreadCount))
    const increased = count > prevCountRef.current
    prevCountRef.current = count

    if (pulseTimerRef.current != null) {
      window.clearTimeout(pulseTimerRef.current)
      pulseTimerRef.current = null
    }

    document.title = count > 0 ? `(${count > 99 ? '99+' : count}) ${BASE_TITLE}` : BASE_TITLE

    if (count > 0 && increased) {
      link.href = drawFavicon(count, true)
      pulseTimerRef.current = window.setTimeout(() => {
        link.href = drawFavicon(count, false)
        pulseTimerRef.current = null
      }, 450)
    } else {
      link.href = drawFavicon(count, false)
    }

    return () => {
      if (pulseTimerRef.current != null) {
        window.clearTimeout(pulseTimerRef.current)
        pulseTimerRef.current = null
      }
    }
  }, [unreadCount])

  useEffect(() => {
    return () => {
      document.title = BASE_TITLE
      const link = document.getElementById(ICON_LINK_ID)
      if (link) {
        ;(link as HTMLLinkElement).href = drawFavicon(0)
      }
    }
  }, [])
}
