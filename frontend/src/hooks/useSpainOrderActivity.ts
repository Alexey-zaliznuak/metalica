import { useEffect, useLayoutEffect, useState } from 'react'
import client from '../api/client'
import { logApiError } from '../api/errors'
import type { OrderCountry } from '../api/types'
import { useAuth } from '../auth/AuthContext'

type Activity = { orderId: number; revisionId: number }
type ActivityState = { latest: Activity; seen: Activity }

const POLL_INTERVAL_MS = 15_000

export function useSpainOrderActivity(country: OrderCountry) {
  const { token } = useAuth()
  const [activity, setActivity] = useState<ActivityState | null>(null)
  const latest = activity?.latest

  useLayoutEffect(() => {
    setActivity(null)
  }, [token])

  useLayoutEffect(() => {
    if (country !== 'es' || !latest) return
    setActivity((current) => (
      current?.latest === latest && current.seen !== latest
        ? { ...current, seen: latest }
        : current
    ))
  }, [country, latest])

  useEffect(() => {
    if (!token) return
    const controller = new AbortController()
    let timer: number | undefined

    async function poll() {
      try {
        const { data } = await client.get<Activity>('/orders/spain-activity', { signal: controller.signal })
        if (controller.signal.aborted) return
        setActivity((current) => {
          if (!current) return { latest: data, seen: data }
          const latest = {
            orderId: Math.max(current.latest.orderId, data.orderId),
            revisionId: Math.max(current.latest.revisionId, data.revisionId),
          }
          return latest.orderId === current.latest.orderId && latest.revisionId === current.latest.revisionId
            ? current
            : { ...current, latest }
        })
      } catch (err) {
        if (!controller.signal.aborted) logApiError('активность по заказам Испании', err)
      } finally {
        if (!controller.signal.aborted) timer = window.setTimeout(poll, POLL_INTERVAL_MS)
      }
    }

    void poll()
    return () => {
      controller.abort()
      window.clearTimeout(timer)
    }
  }, [token])

  return {
    hasNewOrder: country === 'ru' && !!activity && activity.latest.orderId > activity.seen.orderId,
    hasNewRevision: country === 'ru' && !!activity && activity.latest.revisionId > activity.seen.revisionId,
  }
}
