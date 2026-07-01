import { useState, type FormEvent } from 'react'
import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  CircularProgress,
  Stack,
  TextField,
  Typography,
} from '@mui/material'
import PrecisionManufacturingIcon from '@mui/icons-material/PrecisionManufacturing'
import { Navigate, useLocation, useNavigate } from 'react-router-dom'
import { useAuth } from '../auth/AuthContext'
import { BRAND } from '../theme'
import axios from 'axios'

interface LocationState {
  from?: { pathname?: string }
}

export default function LoginPage() {
  const { login, token } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  if (token) {
    const state = location.state as LocationState | null
    const dest = state?.from?.pathname ?? '/orders'
    return <Navigate to={dest} replace />
  }

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault()
    setError(null)
    setLoading(true)
    try {
      await login(username.trim(), password)
      const state = location.state as LocationState | null
      navigate(state?.from?.pathname ?? '/orders', { replace: true })
    } catch (err) {
      if (axios.isAxiosError(err) && err.response?.status === 401) {
        setError('Неверный логин или пароль')
      } else {
        setError('Не удалось войти. Попробуйте позже.')
      }
    } finally {
      setLoading(false)
    }
  }

  return (
    <Box
      sx={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        position: 'relative',
        overflow: 'hidden',
        background: `linear-gradient(135deg, ${BRAND.deep} 0%, ${BRAND.main} 55%, ${BRAND.light} 100%)`,
        p: 2,
        '&::before': {
          content: '""',
          position: 'absolute',
          width: 520,
          height: 520,
          top: -160,
          right: -120,
          borderRadius: '50%',
          background: 'rgba(255,255,255,0.12)',
        },
        '&::after': {
          content: '""',
          position: 'absolute',
          width: 360,
          height: 360,
          bottom: -120,
          left: -100,
          borderRadius: '50%',
          background: 'rgba(255,255,255,0.10)',
        },
      }}
    >
      <Card
        sx={{
          width: '100%',
          maxWidth: 420,
          position: 'relative',
          zIndex: 1,
          borderRadius: 2,
          backdropFilter: 'blur(6px)',
        }}
        elevation={6}
      >
        <CardContent sx={{ p: { xs: 3, sm: 4 } }}>
          <Stack alignItems="center" spacing={1.5} sx={{ mb: 3 }}>
            <Box
              sx={{
                width: 72,
                height: 72,
                borderRadius: '14px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: '#fff',
                background: `linear-gradient(135deg, ${BRAND.deep}, ${BRAND.main})`,
                boxShadow: `0 10px 24px ${BRAND.main}55`,
              }}
            >
              <PrecisionManufacturingIcon sx={{ fontSize: 40 }} />
            </Box>
            <Typography variant="h5" align="center" sx={{ fontWeight: 800 }}>
              Металлити
            </Typography>
            <Typography variant="body2" color="text.secondary" align="center">
              Заказы и правки металлических портретов
            </Typography>
          </Stack>

          <form onSubmit={handleSubmit}>
            <Stack spacing={2}>
              {error && <Alert severity="error">{error}</Alert>}
              <TextField
                label="Логин"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                autoFocus
                required
                fullWidth
                autoComplete="username"
              />
              <TextField
                label="Пароль"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                fullWidth
                autoComplete="current-password"
              />
              <Button
                type="submit"
                variant="contained"
                size="large"
                disabled={loading || !username || !password}
                startIcon={
                  loading ? <CircularProgress size={18} color="inherit" /> : null
                }
              >
                Войти
              </Button>
            </Stack>
          </form>
        </CardContent>
      </Card>
    </Box>
  )
}
