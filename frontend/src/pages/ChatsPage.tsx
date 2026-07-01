import { useCallback, useEffect, useState } from 'react'
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
  FormControl,
  InputLabel,
  ListItemText,
  MenuItem,
  Paper,
  Select,
  Stack,
  TextField,
  Typography,
} from '@mui/material'
import AddIcon from '@mui/icons-material/Add'
import ForumIcon from '@mui/icons-material/Forum'
import { useNavigate } from 'react-router-dom'
import client from '../api/client'
import type { ChatListItem, ChatType, MessageAuthor } from '../api/types'
import { useAuth } from '../auth/AuthContext'
import { useChatSocket } from '../hooks/useChatSocket'
import { formatLastActivity } from '../utils'

type AvailableUser = Pick<MessageAuthor, 'id' | 'name' | 'role'> & { username: string }

const CHAT_TYPE_LABELS: Record<ChatType, string> = {
  PUBLIC: 'Публичный',
  PRIVATE: 'Приватный',
}

export default function ChatsPage() {
  const navigate = useNavigate()
  const { token, user } = useAuth()

  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [chats, setChats] = useState<ChatListItem[]>([])
  const [users, setUsers] = useState<AvailableUser[]>([])

  const [createOpen, setCreateOpen] = useState(false)
  const [creating, setCreating] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [type, setType] = useState<ChatType>('PUBLIC')
  const [memberIds, setMemberIds] = useState<number[]>([])

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const [chatsRes, usersRes] = await Promise.all([
        client.get<ChatListItem[]>('/chats'),
        client.get<AvailableUser[]>('/chats/users'),
      ])
      setChats(chatsRes.data)
      setUsers(usersRes.data)
    } catch {
      setError('Не удалось загрузить список чатов')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  useChatSocket({
    token,
    chatId: null,
    onMessageCreated: () => {},
    onChatUpdated: (chat) => {
      setChats((prev) => {
        const without = prev.filter((item) => item.id !== chat.id)
        return [chat, ...without].sort(
          (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
        )
      })
    },
    onChatDeleted: ({ chatId }) => {
      setChats((prev) => prev.filter((chat) => chat.id !== chatId))
    },
  })

  const createChat = async () => {
    if (!name.trim()) return
    setCreating(true)
    setCreateError(null)
    try {
      const payload = {
        name: name.trim(),
        type,
        memberIds: type === 'PRIVATE' ? memberIds : undefined,
      }
      const { data } = await client.post<ChatListItem>('/chats', payload)
      setChats((prev) => [data, ...prev])
      setCreateOpen(false)
      setName('')
      setType('PUBLIC')
      setMemberIds([])
      navigate(`/chats/${data.id}`)
    } catch {
      setCreateError('Не удалось создать чат')
    } finally {
      setCreating(false)
    }
  }

  const selectableUsers = users.filter((candidate) => candidate.id !== user?.id)

  if (loading) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', py: 8 }}>
        <CircularProgress />
      </Box>
    )
  }

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      <Stack
        direction={{ xs: 'column', sm: 'row' }}
        spacing={2}
        justifyContent="space-between"
        alignItems={{ xs: 'stretch', sm: 'center' }}
      >
        <Box>
          <Typography variant="h5" sx={{ fontWeight: 800 }}>
            Чаты
          </Typography>
          <Typography variant="body2" color="text.secondary">
            Общение внутри сервиса
          </Typography>
        </Box>
        <Button
          variant="contained"
          startIcon={<AddIcon />}
          onClick={() => setCreateOpen(true)}
          sx={{ flexShrink: 0, alignSelf: { xs: 'flex-start', sm: 'auto' } }}
        >
          Создать чат
        </Button>
      </Stack>

      {error && <Alert severity="error">{error}</Alert>}

      {chats.length === 0 ? (
        <Paper variant="outlined" sx={{ p: 4, textAlign: 'center' }}>
          <ForumIcon color="disabled" sx={{ fontSize: 48, mb: 1 }} />
          <Typography color="text.secondary">Чатов пока нет</Typography>
        </Paper>
      ) : (
        <Stack spacing={1.25}>
          {chats.map((chat) => (
            <Paper
              key={chat.id}
              variant="outlined"
              sx={{
                p: 2,
                cursor: 'pointer',
                '&:hover': { borderColor: 'primary.main', boxShadow: 2 },
              }}
              onClick={() => navigate(`/chats/${chat.id}`)}
            >
              <Stack direction="row" justifyContent="space-between" alignItems="center">
                <Box sx={{ minWidth: 0 }}>
                  <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 0.4 }}>
                    <Typography variant="subtitle1" sx={{ fontWeight: 700 }}>
                      {chat.name}
                    </Typography>
                    <Chip size="small" label={CHAT_TYPE_LABELS[chat.type]} />
                  </Stack>
                  <Typography variant="body2" color="text.secondary" noWrap>
                    {chat.lastMessage?.body || 'Пока без сообщений'}
                  </Typography>
                </Box>
                <Box sx={{ textAlign: 'right', flexShrink: 0 }}>
                  <Typography variant="caption" color="text.secondary">
                    {formatLastActivity(chat.lastMessageAt)}
                  </Typography>
                  <Typography variant="caption" display="block" color="text.secondary">
                    участников: {chat.members.length}
                  </Typography>
                </Box>
              </Stack>
            </Paper>
          ))}
        </Stack>
      )}

      <Dialog open={createOpen} onClose={() => !creating && setCreateOpen(false)} fullWidth>
        <DialogTitle>Новый чат</DialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={{ mt: 1 }}>
            {createError && <Alert severity="error">{createError}</Alert>}
            <TextField
              label="Название"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              autoFocus
              fullWidth
            />
            <FormControl fullWidth>
              <InputLabel id="chat-type-label">Тип</InputLabel>
              <Select
                labelId="chat-type-label"
                value={type}
                label="Тип"
                onChange={(e) => setType(e.target.value as ChatType)}
              >
                <MenuItem value="PUBLIC">Публичный</MenuItem>
                <MenuItem value="PRIVATE">Приватный</MenuItem>
              </Select>
            </FormControl>
            <FormControl fullWidth disabled={type !== 'PRIVATE'}>
              <InputLabel id="chat-members-label">Участники</InputLabel>
              <Select
                labelId="chat-members-label"
                multiple
                value={memberIds}
                label="Участники"
                onChange={(e) =>
                  setMemberIds((e.target.value as number[]).map((value) => Number(value)))
                }
                renderValue={(selected) =>
                  selectableUsers
                    .filter((u) => selected.includes(u.id))
                    .map((u) => u.name)
                    .join(', ')
                }
              >
                {selectableUsers.map((candidate) => (
                  <MenuItem key={candidate.id} value={candidate.id}>
                    <ListItemText primary={candidate.name} secondary={candidate.username} />
                  </MenuItem>
                ))}
              </Select>
            </FormControl>
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setCreateOpen(false)} disabled={creating}>
            Отмена
          </Button>
          <Button variant="contained" onClick={createChat} disabled={creating || !name.trim()}>
            Создать
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  )
}
