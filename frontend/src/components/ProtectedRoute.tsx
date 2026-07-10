import { Box, CircularProgress } from '@mui/material'
import { Navigate, useLocation } from 'react-router-dom'
import type { ReactNode } from 'react'
import { useAuth } from '../auth/AuthContext'
import { hasScope } from '../utils'
import type { UserScope } from '../api/types'

export default function ProtectedRoute({
  children,
  requireAdmin = false,
  requiredScopes,
}: {
  children: ReactNode
  requireAdmin?: boolean
  // Достаточно любого из перечисленных скоупов. ADMIN проходит всегда.
  requiredScopes?: UserScope[]
}) {
  const { token, user, loading } = useAuth()
  const location = useLocation()

  if (token && loading && !user) {
    return (
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          minHeight: '100vh',
        }}
      >
        <CircularProgress />
      </Box>
    )
  }

  if (!token) {
    return <Navigate to="/login" replace state={{ from: location }} />
  }

  if (requireAdmin && user?.role !== 'ADMIN') {
    return <Navigate to="/orders" replace />
  }

  if (
    requiredScopes &&
    requiredScopes.length > 0 &&
    !requiredScopes.some((scope) => hasScope(user?.role, user?.scopes, scope))
  ) {
    return <Navigate to="/orders" replace />
  }

  return <>{children}</>
}
