import { Box, CircularProgress } from '@mui/material'
import { Navigate, useLocation } from 'react-router-dom'
import type { ReactNode } from 'react'
import { useAuth } from '../auth/AuthContext'

export default function ProtectedRoute({
  children,
  requireAdmin = false,
}: {
  children: ReactNode
  requireAdmin?: boolean
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

  return <>{children}</>
}
