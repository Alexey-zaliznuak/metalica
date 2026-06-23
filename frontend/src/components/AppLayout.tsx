import {
  AppBar,
  Avatar,
  Box,
  Button,
  Chip,
  Container,
  Stack,
  Toolbar,
  Tooltip,
  Typography,
} from '@mui/material'
import LogoutIcon from '@mui/icons-material/Logout'
import ListAltIcon from '@mui/icons-material/ListAlt'
import InsightsIcon from '@mui/icons-material/Insights'
import GroupIcon from '@mui/icons-material/Group'
import AssignmentTurnedInIcon from '@mui/icons-material/AssignmentTurnedIn'
import PrecisionManufacturingIcon from '@mui/icons-material/PrecisionManufacturing'
import type { ReactNode } from 'react'
import { NavLink, useNavigate } from 'react-router-dom'
import { useAuth } from '../auth/AuthContext'
import { roleLabel } from '../utils'

function NavButton({
  to,
  icon,
  label,
}: {
  to: string
  icon: ReactNode
  label: string
}) {
  return (
    <Button
      component={NavLink}
      to={to}
      startIcon={icon}
      color="inherit"
      sx={{
        borderRadius: 999,
        px: 2,
        opacity: 0.9,
        '&.active': {
          bgcolor: 'rgba(255,255,255,0.22)',
          opacity: 1,
          boxShadow: 'inset 0 0 0 1px rgba(255,255,255,0.25)',
        },
        '&:hover': { bgcolor: 'rgba(255,255,255,0.14)' },
      }}
    >
      {label}
    </Button>
  )
}

function initials(name: string): string {
  return name
    .split(' ')
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() ?? '')
    .join('')
}

export default function AppLayout({ children }: { children: ReactNode }) {
  const { user, logout } = useAuth()
  const navigate = useNavigate()

  const handleLogout = () => {
    logout()
    navigate('/login', { replace: true })
  }

  return (
    <Box sx={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
      <AppBar position="sticky" color="primary">
        <Toolbar sx={{ gap: 1 }}>
          <Stack
            direction="row"
            spacing={1.25}
            alignItems="center"
            component={NavLink}
            to="/orders"
            sx={{
              mr: 2,
              whiteSpace: 'nowrap',
              textDecoration: 'none',
              color: 'inherit',
            }}
          >
            <Box
              sx={{
                width: 34,
                height: 34,
                borderRadius: '8px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                bgcolor: 'rgba(255,255,255,0.18)',
                boxShadow: 'inset 0 0 0 1px rgba(255,255,255,0.25)',
              }}
            >
              <PrecisionManufacturingIcon sx={{ fontSize: 20 }} />
            </Box>
            <Box sx={{ display: { xs: 'none', sm: 'block' }, lineHeight: 1.05 }}>
              <Typography sx={{ fontWeight: 800, fontSize: 17 }}>
                Металлика
              </Typography>
              <Typography sx={{ fontSize: 11, opacity: 0.8 }}>
                заказы и правки
              </Typography>
            </Box>
          </Stack>

          <Stack direction="row" spacing={1} sx={{ flexGrow: 1 }}>
            <NavButton to="/orders" icon={<ListAltIcon />} label="Заказы" />
            <NavButton to="/metrics" icon={<InsightsIcon />} label="Метрики" />
            <NavButton to="/workload" icon={<AssignmentTurnedInIcon />} label="Нагрузка" />
            {user?.role === 'ADMIN' && (
              <NavButton to="/users" icon={<GroupIcon />} label="Пользователи" />
            )}
          </Stack>

          {user && (
            <Stack
              direction="row"
              spacing={1.5}
              alignItems="center"
              sx={{ mr: 1 }}
            >
              <Avatar
                sx={{
                  width: 34,
                  height: 34,
                  bgcolor: 'secondary.main',
                  fontSize: 14,
                }}
              >
                {initials(user.name)}
              </Avatar>
              <Box sx={{ display: { xs: 'none', sm: 'block' }, lineHeight: 1.1 }}>
                <Typography variant="body2" sx={{ fontWeight: 600 }}>
                  {user.name}
                </Typography>
                <Chip
                  size="small"
                  label={roleLabel(user.role)}
                  sx={{
                    height: 18,
                    fontSize: 11,
                    bgcolor: 'rgba(255,255,255,0.18)',
                    color: 'inherit',
                  }}
                />
              </Box>
            </Stack>
          )}

          <Tooltip title="Выйти">
            <Button
              color="inherit"
              onClick={handleLogout}
              startIcon={<LogoutIcon />}
            >
              Выйти
            </Button>
          </Tooltip>
        </Toolbar>
      </AppBar>

      <Container
        maxWidth="lg"
        sx={{ flexGrow: 1, display: 'flex', flexDirection: 'column', py: 3 }}
      >
        {children}
      </Container>
    </Box>
  )
}
