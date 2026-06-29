import {
  AppBar,
  Avatar,
  Box,
  Button,
  Chip,
  Container,
  Divider,
  Drawer,
  IconButton,
  List,
  ListItemButton,
  ListItemIcon,
  ListItemText,
  Stack,
  Toolbar,
  Tooltip,
  Typography,
} from '@mui/material'
import LogoutIcon from '@mui/icons-material/Logout'
import MenuIcon from '@mui/icons-material/Menu'
import ListAltIcon from '@mui/icons-material/ListAlt'
import InsightsIcon from '@mui/icons-material/Insights'
import GroupIcon from '@mui/icons-material/Group'
import AssignmentTurnedInIcon from '@mui/icons-material/AssignmentTurnedIn'
import PrecisionManufacturingIcon from '@mui/icons-material/PrecisionManufacturing'
import ForumIcon from '@mui/icons-material/Forum'
import { useState, type ReactNode } from 'react'
import { NavLink, useLocation, useNavigate } from 'react-router-dom'
import { useAuth } from '../auth/AuthContext'
import { roleLabel } from '../utils'

interface NavItem {
  to: string
  icon: ReactNode
  label: string
  adminOnly?: boolean
}

const NAV_ITEMS: NavItem[] = [
  { to: '/orders', icon: <ListAltIcon />, label: 'Заказы' },
  { to: '/chats', icon: <ForumIcon />, label: 'Чаты' },
  { to: '/metrics', icon: <InsightsIcon />, label: 'Метрики' },
  { to: '/workload', icon: <AssignmentTurnedInIcon />, label: 'Нагрузка' },
  { to: '/users', icon: <GroupIcon />, label: 'Пользователи', adminOnly: true },
]

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
        whiteSpace: 'nowrap',
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
  const location = useLocation()
  const isOrdersBoardPage = location.pathname === '/orders'
  const [drawerOpen, setDrawerOpen] = useState(false)

  const handleLogout = () => {
    logout()
    navigate('/login', { replace: true })
  }

  const visibleNavItems = NAV_ITEMS.filter(
    (item) => !item.adminOnly || user?.role === 'ADMIN',
  )

  return (
    <Box sx={{ minHeight: '100dvh', display: 'flex', flexDirection: 'column' }}>
      <AppBar position="sticky" color="primary">
        <Toolbar sx={{ gap: 1 }}>
          <IconButton
            color="inherit"
            edge="start"
            aria-label="Открыть меню"
            onClick={() => setDrawerOpen(true)}
            sx={{ display: { xs: 'inline-flex', md: 'none' } }}
          >
            <MenuIcon />
          </IconButton>

          <Stack
            direction="row"
            spacing={1.25}
            alignItems="center"
            component={NavLink}
            to="/orders"
            sx={{
              mr: { xs: 0, md: 2 },
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
                flexShrink: 0,
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

          <Stack
            direction="row"
            spacing={1}
            sx={{ flexGrow: 1, display: { xs: 'none', md: 'flex' } }}
          >
            {visibleNavItems.map((item) => (
              <NavButton
                key={item.to}
                to={item.to}
                icon={item.icon}
                label={item.label}
              />
            ))}
          </Stack>

          {/* Spacer for mobile/tablet where the horizontal nav is hidden */}
          <Box sx={{ flexGrow: 1, display: { xs: 'block', md: 'none' } }} />

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
              sx={{ minWidth: { xs: 40, sm: 'auto' }, px: { xs: 1, sm: 2 } }}
            >
              <LogoutIcon fontSize="small" />
              <Box component="span" sx={{ display: { xs: 'none', sm: 'inline' }, ml: 1 }}>
                Выйти
              </Box>
            </Button>
          </Tooltip>
        </Toolbar>
      </AppBar>

      <Drawer
        anchor="left"
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        sx={{ display: { xs: 'block', md: 'none' } }}
        PaperProps={{ sx: { width: 280 } }}
      >
        <Box sx={{ p: 2 }}>
          <Stack direction="row" spacing={1.25} alignItems="center">
            <Box
              sx={{
                width: 38,
                height: 38,
                borderRadius: '8px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: '#fff',
                background: 'linear-gradient(135deg, #2C5EAD, #1591DC)',
                flexShrink: 0,
              }}
            >
              <PrecisionManufacturingIcon sx={{ fontSize: 22 }} />
            </Box>
            <Box>
              <Typography sx={{ fontWeight: 800 }}>Металлика</Typography>
              <Typography variant="caption" color="text.secondary">
                заказы и правки
              </Typography>
            </Box>
          </Stack>
        </Box>
        <Divider />
        {user && (
          <>
            <Stack direction="row" spacing={1.5} alignItems="center" sx={{ px: 2, py: 1.5 }}>
              <Avatar sx={{ width: 38, height: 38, bgcolor: 'secondary.main', fontSize: 15 }}>
                {initials(user.name)}
              </Avatar>
              <Box sx={{ minWidth: 0 }}>
                <Typography variant="body2" sx={{ fontWeight: 700 }} noWrap>
                  {user.name}
                </Typography>
                <Typography variant="caption" color="text.secondary">
                  {roleLabel(user.role)}
                </Typography>
              </Box>
            </Stack>
            <Divider />
          </>
        )}
        <List sx={{ flexGrow: 1, py: 1 }}>
          {visibleNavItems.map((item) => {
            const active =
              location.pathname === item.to ||
              location.pathname.startsWith(`${item.to}/`)
            return (
              <ListItemButton
                key={item.to}
                onClick={() => {
                  setDrawerOpen(false)
                  navigate(item.to)
                }}
                selected={active}
                sx={{ mx: 1, borderRadius: 1.5 }}
              >
                <ListItemIcon sx={{ minWidth: 40, color: active ? 'primary.main' : undefined }}>
                  {item.icon}
                </ListItemIcon>
                <ListItemText
                  primary={item.label}
                  primaryTypographyProps={{ fontWeight: active ? 700 : 500 }}
                />
              </ListItemButton>
            )
          })}
        </List>
        <Divider />
        <Box sx={{ p: 1.5 }}>
          <Button
            fullWidth
            color="inherit"
            startIcon={<LogoutIcon />}
            onClick={() => {
              setDrawerOpen(false)
              handleLogout()
            }}
            sx={{ justifyContent: 'flex-start', px: 2 }}
          >
            Выйти
          </Button>
        </Box>
      </Drawer>

      <Container
        maxWidth={isOrdersBoardPage ? 'xl' : 'lg'}
        sx={{
          flexGrow: 1,
          display: 'flex',
          flexDirection: 'column',
          py: { xs: 2, sm: 3 },
        }}
      >
        {children}
      </Container>
    </Box>
  )
}
