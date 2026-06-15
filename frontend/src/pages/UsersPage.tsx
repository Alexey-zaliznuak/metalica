import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react'
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  IconButton,
  InputAdornment,
  MenuItem,
  Paper,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material'
import PersonAddIcon from '@mui/icons-material/PersonAdd'
import EditIcon from '@mui/icons-material/Edit'
import Visibility from '@mui/icons-material/Visibility'
import VisibilityOff from '@mui/icons-material/VisibilityOff'
import { AxiosError } from 'axios'
import client from '../api/client'
import type {
  AdminUser,
  CreateUserPayload,
  UpdateUserPayload,
  UserRole,
} from '../api/types'
import { ASSIGNABLE_ROLES, formatDateTime, roleLabel } from '../utils'

const ROLE_CHIP_COLOR: Record<string, 'default' | 'primary' | 'secondary' | 'warning'> = {
  ADMIN: 'warning',
  MANAGER: 'primary',
  DESIGNER: 'secondary',
}

export default function UsersPage() {
  const [users, setUsers] = useState<AdminUser[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [dialogOpen, setDialogOpen] = useState(false)
  // null = создание нового аккаунта, иначе — редактирование существующего.
  const [editingUser, setEditingUser] = useState<AdminUser | null>(null)
  const [username, setUsername] = useState('')
  const [name, setName] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [role, setRole] = useState<UserRole>('MANAGER')
  const [saving, setSaving] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)

  const isEditing = editingUser !== null

  const fetchUsers = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const { data } = await client.get<AdminUser[]>('/users')
      setUsers(data)
    } catch {
      setError('Не удалось загрузить пользователей')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchUsers()
  }, [fetchUsers])

  const openCreate = () => {
    setEditingUser(null)
    setUsername('')
    setName('')
    setPassword('')
    setShowPassword(false)
    setRole('MANAGER')
    setFormError(null)
    setDialogOpen(true)
  }

  const openEdit = (u: AdminUser) => {
    setEditingUser(u)
    setUsername(u.username)
    setName(u.name)
    setPassword('')
    setShowPassword(false)
    setRole(u.role)
    setFormError(null)
    setDialogOpen(true)
  }

  const canSubmit = useMemo(
    () =>
      username.trim().length >= 3 &&
      name.trim().length >= 1 &&
      // При создании пароль обязателен, при редактировании — опционален.
      (isEditing ? password.length === 0 || password.length >= 6 : password.length >= 6) &&
      !saving,
    [username, name, password, isEditing, saving],
  )

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault()
    if (!canSubmit) return
    setSaving(true)
    setFormError(null)
    try {
      if (isEditing && editingUser) {
        const payload: UpdateUserPayload = {
          username: username.trim(),
          name: name.trim(),
          role,
        }
        if (password.length >= 6) {
          payload.password = password
        }
        const { data } = await client.patch<AdminUser>(
          `/users/${editingUser.id}`,
          payload,
        )
        setUsers((prev) => prev.map((u) => (u.id === data.id ? data : u)))
      } else {
        const payload: CreateUserPayload = {
          username: username.trim(),
          name: name.trim(),
          password,
          role,
        }
        const { data } = await client.post<AdminUser>('/users', payload)
        setUsers((prev) => [...prev, data])
      }
      setDialogOpen(false)
    } catch (err) {
      const status = (err as AxiosError)?.response?.status
      setFormError(
        status === 409
          ? 'Пользователь с таким логином уже существует'
          : isEditing
            ? 'Не удалось сохранить изменения'
            : 'Не удалось создать аккаунт',
      )
    } finally {
      setSaving(false)
    }
  }

  return (
    <Box>
      <Stack
        direction={{ xs: 'column', sm: 'row' }}
        spacing={2}
        alignItems={{ xs: 'stretch', sm: 'center' }}
        justifyContent="space-between"
        sx={{ mb: 3 }}
      >
        <Box>
          <Typography variant="h4" sx={{ fontWeight: 800 }}>
            Пользователи
          </Typography>
          <Typography variant="body2" color="text.secondary">
            Управление аккаунтами и ролями
          </Typography>
        </Box>
        <Button
          variant="contained"
          startIcon={<PersonAddIcon />}
          onClick={openCreate}
        >
          Создать аккаунт
        </Button>
      </Stack>

      {error && (
        <Alert severity="error" sx={{ mb: 2 }}>
          {error}
        </Alert>
      )}

      <Paper variant="outlined" sx={{ borderRadius: 1.5, overflow: 'hidden' }}>
        <TableContainer>
          <Table>
            <TableHead>
              <TableRow>
                <TableCell>ID</TableCell>
                <TableCell>Логин</TableCell>
                <TableCell>Имя</TableCell>
                <TableCell>Роль</TableCell>
                <TableCell>Создан</TableCell>
                <TableCell align="right">Действия</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {loading && (
                <TableRow>
                  <TableCell colSpan={6} align="center" sx={{ py: 6 }}>
                    <CircularProgress />
                  </TableCell>
                </TableRow>
              )}
              {!loading && users.length === 0 && (
                <TableRow>
                  <TableCell colSpan={6} align="center" sx={{ py: 6 }}>
                    <Typography color="text.secondary">
                      Пользователей пока нет
                    </Typography>
                  </TableCell>
                </TableRow>
              )}
              {!loading &&
                users.map((u) => (
                  <TableRow key={u.id} hover>
                    <TableCell>{u.id}</TableCell>
                    <TableCell sx={{ fontWeight: 600 }}>{u.username}</TableCell>
                    <TableCell>{u.name}</TableCell>
                    <TableCell>
                      <Chip
                        size="small"
                        label={roleLabel(u.role)}
                        color={ROLE_CHIP_COLOR[u.role] ?? 'default'}
                        variant="filled"
                      />
                    </TableCell>
                    <TableCell>
                      <Typography variant="body2" color="text.secondary">
                        {formatDateTime(u.createdAt)}
                      </Typography>
                    </TableCell>
                    <TableCell align="right">
                      <Tooltip title="Редактировать">
                        <IconButton size="small" onClick={() => openEdit(u)}>
                          <EditIcon fontSize="small" />
                        </IconButton>
                      </Tooltip>
                    </TableCell>
                  </TableRow>
                ))}
            </TableBody>
          </Table>
        </TableContainer>
      </Paper>

      <Dialog
        open={dialogOpen}
        onClose={() => !saving && setDialogOpen(false)}
        fullWidth
        maxWidth="sm"
      >
        <form onSubmit={handleSubmit}>
          <DialogTitle>
            {isEditing ? 'Редактирование аккаунта' : 'Новый аккаунт'}
          </DialogTitle>
          <DialogContent>
            <Stack spacing={2} sx={{ mt: 1 }}>
              {formError && <Alert severity="error">{formError}</Alert>}
              <TextField
                label="Логин"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                required
                fullWidth
                autoFocus
                helperText="Минимум 3 символа"
              />
              <TextField
                label="Имя"
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
                fullWidth
              />
              <TextField
                label={isEditing ? 'Новый пароль' : 'Пароль'}
                type={showPassword ? 'text' : 'password'}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required={!isEditing}
                fullWidth
                helperText={
                  isEditing
                    ? 'Оставьте пустым, чтобы не менять. Минимум 6 символов'
                    : 'Минимум 6 символов'
                }
                InputProps={{
                  endAdornment: (
                    <InputAdornment position="end">
                      <IconButton
                        onClick={() => setShowPassword((v) => !v)}
                        edge="end"
                        size="small"
                      >
                        {showPassword ? <VisibilityOff /> : <Visibility />}
                      </IconButton>
                    </InputAdornment>
                  ),
                }}
              />
              <TextField
                select
                label="Роль"
                value={role}
                onChange={(e) => setRole(e.target.value as UserRole)}
                fullWidth
              >
                {ASSIGNABLE_ROLES.map((r) => (
                  <MenuItem key={r.value} value={r.value}>
                    {r.label}
                  </MenuItem>
                ))}
              </TextField>
            </Stack>
          </DialogContent>
          <DialogActions sx={{ px: 3, pb: 2 }}>
            <Button onClick={() => setDialogOpen(false)} disabled={saving}>
              Отмена
            </Button>
            <Button
              type="submit"
              variant="contained"
              disabled={!canSubmit}
              startIcon={
                saving ? <CircularProgress size={18} color="inherit" /> : null
              }
            >
              {isEditing ? 'Сохранить' : 'Создать'}
            </Button>
          </DialogActions>
        </form>
      </Dialog>
    </Box>
  )
}
