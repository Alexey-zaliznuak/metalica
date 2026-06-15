import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
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

export function AuthProvider({ children }: { children: ReactNode }) {
  const [token, setToken] = useState<string | null>(() =>
    localStorage.getItem(TOKEN_KEY),
  )
  const [user, setUser] = useState<User | null>(() => readStoredUser())
  const [loading, setLoading] = useState<boolean>(!!token && !readStoredUser())

  const persist = useCallback((nextToken: string | null, nextUser: User | null) => {
    if (nextToken) {
      localStorage.setItem(TOKEN_KEY, nextToken)
    } else {
      localStorage.removeItem(TOKEN_KEY)
    }
    if (nextUser) {
      localStorage.setItem(USER_KEY, JSON.stringify(nextUser))
    } else {
      localStorage.removeItem(USER_KEY)
    }
    setToken(nextToken)
    setUser(nextUser)
  }, [])

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
    persist(null, null)
  }, [persist])

  const me = useCallback(async () => {
    const { data } = await client.get<User>('/auth/me')
    setUser(data)
    localStorage.setItem(USER_KEY, JSON.stringify(data))
    return data
  }, [])

  // If we have a token but no cached user, fetch the profile once.
  useEffect(() => {
    let active = true
    if (token && !user) {
      setLoading(true)
      me()
        .catch(() => {
          if (active) persist(null, null)
        })
        .finally(() => {
          if (active) setLoading(false)
        })
    }
    return () => {
      active = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const value = useMemo<AuthContextValue>(
    () => ({ user, token, loading, login, logout, me }),
    [user, token, loading, login, logout, me],
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
