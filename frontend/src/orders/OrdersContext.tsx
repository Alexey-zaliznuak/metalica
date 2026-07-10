import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from 'react'
import client from '../api/client'
import { useAuth } from '../auth/AuthContext'
import type { BluesalesStatusOption, Order } from '../api/types'

const POLL_INTERVAL_MS = 10_000

interface OrdersContextValue {
  orders: Order[]
  setOrders: Dispatch<SetStateAction<Order[]>>
  /** Заказы загружены хотя бы один раз (кэш «прогрет»). */
  initialLoadDone: boolean
  error: string | null
  setError: Dispatch<SetStateAction<string | null>>
  statuses: BluesalesStatusOption[]
  statusesLoaded: boolean
  statusesError: boolean
  /**
   * Задаёт актуальные параметры выборки (поиск + статусы колонок) и обновляет
   * заказы. Провайдер запоминает параметры и продолжает по ним авто-рефреш,
   * даже когда пользователь ушёл со страницы заказов.
   */
  applyParams: (q: string, statusIds: number[]) => void
  /** Принудительный фоновый рефреш по последним параметрам. */
  refresh: () => void
  /**
   * Пока пользователь перетаскивает карточку (или идёт оптимистичный перенос),
   * фоновый рефреш не должен затирать локальное состояние доски. Оборачивайте
   * взаимодействие в begin/endInteraction — они вложенные (счётчик).
   */
  beginInteraction: () => void
  endInteraction: () => void
}

const OrdersContext = createContext<OrdersContextValue | undefined>(undefined)

export function OrdersProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth()
  const userId = user?.id ?? null

  const [orders, setOrders] = useState<Order[]>([])
  const [initialLoadDone, setInitialLoadDone] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [statuses, setStatuses] = useState<BluesalesStatusOption[]>([])
  const [statusesLoaded, setStatusesLoaded] = useState(false)
  const [statusesError, setStatusesError] = useState(false)

  const paramsRef = useRef<{ q: string; statusIds: number[] }>({ q: '', statusIds: [] })
  const hasParamsRef = useRef(false)
  const initialLoadDoneRef = useRef(false)
  // Счётчик активных взаимодействий (drag / оптимистичный перенос). Пока > 0,
  // ответы рефреша игнорируются, чтобы не сбить пользователя.
  const pauseCountRef = useRef(0)
  // Токен последнего запроса: применяем только самый свежий ответ, чтобы гонки
  // (смена фильтра + поллинг) не приводили к «прыжкам» устаревших данных.
  const reqSeqRef = useRef(0)

  const fetchOrders = useCallback(async (background: boolean) => {
    if (!hasParamsRef.current) return
    const seq = ++reqSeqRef.current
    if (!background) setError(null)
    try {
      const { q, statusIds } = paramsRef.current
      const { data } = await client.get<{ items: Order[] }>('/orders', {
        params: {
          q: q || undefined,
          orderStatusIds: statusIds.join(','),
        },
      })
      // Пришёл более свежий запрос — этот ответ уже неактуален.
      if (seq !== reqSeqRef.current) return
      // Пользователь перетаскивает карточку — не трогаем состояние доски.
      if (pauseCountRef.current > 0) return
      setOrders(data.items)
      setError(null)
      if (!initialLoadDoneRef.current) {
        initialLoadDoneRef.current = true
        setInitialLoadDone(true)
      }
    } catch {
      // Фоновые ошибки не показываем — не мешаем работать с уже загруженными
      // данными; ошибку покажем только для первой (переднеплановой) загрузки.
      if (!background && !initialLoadDoneRef.current) {
        setError('Не удалось загрузить заказы')
      }
    }
  }, [])

  const applyParams = useCallback(
    (q: string, statusIds: number[]) => {
      paramsRef.current = { q, statusIds }
      hasParamsRef.current = true
      void fetchOrders(initialLoadDoneRef.current)
    },
    [fetchOrders],
  )

  const refresh = useCallback(() => {
    void fetchOrders(true)
  }, [fetchOrders])

  const beginInteraction = useCallback(() => {
    pauseCountRef.current += 1
  }, [])

  const endInteraction = useCallback(() => {
    pauseCountRef.current = Math.max(0, pauseCountRef.current - 1)
  }, [])

  // Статусы заказов (колонки доски) редко меняются — грузим один раз на всю
  // сессию и кэшируем, чтобы доска не мигала при возврате на страницу.
  useEffect(() => {
    let active = true
    void client
      .get<BluesalesStatusOption[]>('/orders/order-statuses')
      .then((res) => {
        if (!active) return
        setStatuses(res.data)
        setStatusesLoaded(true)
      })
      .catch(() => {
        if (!active) return
        setStatusesError(true)
        setStatusesLoaded(true)
      })
    return () => {
      active = false
    }
  }, [])

  // Авто-рефреш раз в 10 секунд независимо от того, на какой странице
  // пользователь. Пропускаем, если вкладка скрыта или идёт перетаскивание.
  useEffect(() => {
    const id = setInterval(() => {
      if (document.hidden) return
      if (pauseCountRef.current > 0) return
      if (!hasParamsRef.current) return
      void fetchOrders(true)
    }, POLL_INTERVAL_MS)
    return () => clearInterval(id)
  }, [fetchOrders])

  // При возврате на вкладку сразу подтягиваем свежие данные.
  useEffect(() => {
    const onVisibility = () => {
      if (document.hidden) return
      if (pauseCountRef.current > 0) return
      if (!hasParamsRef.current) return
      void fetchOrders(true)
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => document.removeEventListener('visibilitychange', onVisibility)
  }, [fetchOrders])

  // Смена пользователя (logout / вход под другим аккаунтом) сбрасывает кэш.
  const prevUserRef = useRef<number | null>(userId)
  useEffect(() => {
    if (prevUserRef.current === userId) return
    prevUserRef.current = userId
    reqSeqRef.current += 1
    hasParamsRef.current = false
    paramsRef.current = { q: '', statusIds: [] }
    initialLoadDoneRef.current = false
    pauseCountRef.current = 0
    setOrders([])
    setInitialLoadDone(false)
    setError(null)
  }, [userId])

  const value = useMemo<OrdersContextValue>(
    () => ({
      orders,
      setOrders,
      initialLoadDone,
      error,
      setError,
      statuses,
      statusesLoaded,
      statusesError,
      applyParams,
      refresh,
      beginInteraction,
      endInteraction,
    }),
    [
      orders,
      initialLoadDone,
      error,
      statuses,
      statusesLoaded,
      statusesError,
      applyParams,
      refresh,
      beginInteraction,
      endInteraction,
    ],
  )

  return <OrdersContext.Provider value={value}>{children}</OrdersContext.Provider>
}

export function useOrders(): OrdersContextValue {
  const ctx = useContext(OrdersContext)
  if (!ctx) {
    throw new Error('useOrders must be used within an OrdersProvider')
  }
  return ctx
}
