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
import client, { TOKEN_KEY, USER_KEY } from '../api/client'
import type { LoginResponse, User } from '../api/types'

interface AuthContextValue {
  user: User | null
  token: string | null
  loading: boolean
  login: (username: string, password: string) => Promise<void>
  logout: () => void
  me: () => Promise<User>
  /**
   * Merge a partial patch into the account-wide frontendSettings. The backend
   * (User.frontendSettings) is the single source of truth so the same settings
   * follow the account across devices. The update is applied optimistically to
   * the in-memory user and the localStorage cache, then persisted to the
   * backend (debounced). The debounce lives here, above the router, so pending
   * writes are not cancelled when a page unmounts during navigation.
   */
  updateFrontendSettings: (patch: Record<string, unknown>) => void
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined)

function readStoredUser(): User | null {
  const raw = localStorage.getItem(USER_KEY)
  if (!raw) return null
  try {
    return JSON.parse(raw) as User
  } catch {
    return null
  }
}

function extractSettings(user: User | null): Record<string, unknown> {
  const settings = user?.frontendSettings
  return settings && typeof settings === 'object' && !Array.isArray(settings)
    ? (settings as Record<string, unknown>)
    : {}
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [token, setToken] = useState<string | null>(() =>
    localStorage.getItem(TOKEN_KEY),
  )
  const [user, setUser] = useState<User | null>(() => readStoredUser())
  const [loading, setLoading] = useState<boolean>(!!token && !readStoredUser())

  // Mirrors the latest frontendSettings so debounced writes always send the
  // freshest merged value regardless of React's render timing.
  const settingsRef = useRef<Record<string, unknown>>(extractSettings(readStoredUser()))
  const patchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const cacheUser = useCallback((nextUser: User | null) => {
    if (nextUser) {
      settingsRef.current = extractSettings(nextUser)
      localStorage.setItem(USER_KEY, JSON.stringify(nextUser))
    } else {
      settingsRef.current = {}
      localStorage.removeItem(USER_KEY)
    }
    setUser(nextUser)
  }, [])

  const persist = useCallback(
    (nextToken: string | null, nextUser: User | null) => {
      if (nextToken) {
        localStorage.setItem(TOKEN_KEY, nextToken)
      } else {
        localStorage.removeItem(TOKEN_KEY)
      }
      setToken(nextToken)
      cacheUser(nextUser)
    },
    [cacheUser],
  )

  const login = useCallback(
    async (username: string, password: string) => {
      const { data } = await client.post<LoginResponse>('/auth/login', {
        username,
        password,
      })
      persist(data.accessToken, data.user)
    },
    [persist],
  )

  const logout = useCallback(() => {
    if (patchTimerRef.current) clearTimeout(patchTimerRef.current)
    persist(null, null)
  }, [persist])

  const me = useCallback(async () => {
    const { data } = await client.get<User>('/auth/me')
    cacheUser(data)
    return data
  }, [cacheUser])

  const updateFrontendSettings = useCallback(
    (patch: Record<string, unknown>) => {
      const merged = { ...settingsRef.current, ...patch }
      settingsRef.current = merged

      // Optimistic update of the in-memory user + cache for instant feedback.
      setUser((prev) => {
        if (!prev) return prev
        const next = { ...prev, frontendSettings: merged }
        localStorage.setItem(USER_KEY, JSON.stringify(next))
        return next
      })

      // Persist to the backend (source of truth) with a debounce.
      if (patchTimerRef.current) clearTimeout(patchTimerRef.current)
      patchTimerRef.current = setTimeout(() => {
        void client
          .patch<User>('/auth/frontend-settings', {
            frontendSettings: settingsRef.current,
          })
          .then(({ data }) => {
            settingsRef.current = extractSettings(data)
            setUser((prev) => {
              if (!prev) return prev
              const next = { ...prev, frontendSettings: data.frontendSettings }
              localStorage.setItem(USER_KEY, JSON.stringify(next))
              return next
            })
          })
          .catch(() => {
            /* keep optimistic state; the next change will retry the write */
          })
      }, 500)
    },
    [],
  )

  // On app load, always refresh the user from the backend so that settings
  // changed on another device propagate here. The cached user (if any) is used
  // for the initial paint; a failed refresh keeps the cached session.
  useEffect(() => {
    let active = true
    if (token) {
      me()
        .catch(() => {
          if (active && !readStoredUser()) persist(null, null)
        })
        .finally(() => {
          if (active) setLoading(false)
        })
    } else {
      setLoading(false)
    }
    return () => {
      active = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const value = useMemo<AuthContextValue>(
    () => ({ user, token, loading, login, logout, me, updateFrontendSettings }),
    [user, token, loading, login, logout, me, updateFrontendSettings],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext)
  if (!ctx) {
    throw new Error('useAuth must be used within an AuthProvider')
  }
  return ctx
}
