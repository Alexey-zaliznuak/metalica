import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from 'react'
import {
  Alert,
  Avatar,
  Box,
  Button,
  Chip,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  IconButton,
  List,
  ListItem,
  ListItemText,
  MenuItem,
  Paper,
  Stack,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material'
import ArrowBackIcon from '@mui/icons-material/ArrowBack'
import SendIcon from '@mui/icons-material/Send'
import ImageIcon from '@mui/icons-material/Image'
import CloseIcon from '@mui/icons-material/Close'
import EditIcon from '@mui/icons-material/Edit'
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline'
import GroupIcon from '@mui/icons-material/Group'
import { useNavigate, useParams } from 'react-router-dom'
import client from '../api/client'
import type {
  ChatListItem,
  ChatMemberUser,
  ChatMessage,
  UploadResponse,
} from '../api/types'
import { useAuth } from '../auth/AuthContext'
import { useChatSocket } from '../hooks/useChatSocket'
import { formatTime, roleLabel } from '../utils'

interface PendingImage {
  id: string
  file: File
  previewUrl: string
}

function initials(name: string): string {
  return name
    .split(' ')
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('')
}

export default function ChatThreadPage() {
  const { id } = useParams<{ id: string }>()
  const chatId = Number(id)
  const navigate = useNavigate()
  const { user, token } = useAuth()

  const [chat, setChat] = useState<ChatListItem | null>(null)
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [sendError, setSendError] = useState<string | null>(null)
  const [sending, setSending] = useState(false)
  const [body, setBody] = useState('')
  const [pendingImages, setPendingImages] = useState<PendingImage[]>([])
  const [dragOver, setDragOver] = useState(false)
  const [lightbox, setLightbox] = useState<string | null>(null)
  const [editingMessageId, setEditingMessageId] = useState<number | null>(null)
  const [editingText, setEditingText] = useState('')
  const [editing, setEditing] = useState(false)
  const [membersOpen, setMembersOpen] = useState(false)
  const [membersLoading, setMembersLoading] = useState(false)
  const [membersError, setMembersError] = useState<string | null>(null)
  const [availableUsers, setAvailableUsers] = useState<ChatMemberUser[]>([])
  const [selectedUserId, setSelectedUserId] = useState<number | ''>('')
  const [membersSaving, setMembersSaving] = useState(false)

  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const listEndRef = useRef<HTMLDivElement | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const [chatRes, messagesRes] = await Promise.all([
        client.get<ChatListItem>(`/chats/${chatId}`),
        client.get<ChatMessage[]>(`/chats/${chatId}/messages`),
      ])
      setChat(chatRes.data)
      setMessages(messagesRes.data)
    } catch {
      setError('Не удалось загрузить чат')
    } finally {
      setLoading(false)
    }
  }, [chatId])

  useEffect(() => {
    if (Number.isFinite(chatId)) {
      void load()
    }
  }, [chatId, load])

  useEffect(() => {
    listEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  useChatSocket({
    token,
    chatId: Number.isFinite(chatId) ? chatId : null,
    onMessageCreated: (message) => {
      if (message.chatId !== chatId) return
      setMessages((prev) => {
        if (prev.some((entry) => entry.id === message.id)) {
          return prev
        }
        return [...prev, message]
      })
    },
    onMessageUpdated: (updatedMessage) => {
      if (updatedMessage.chatId !== chatId) return
      setMessages((prev) =>
        prev.map((message) =>
          message.id === updatedMessage.id ? updatedMessage : message,
        ),
      )
    },
    onChatUpdated: (updatedChat) => {
      if (updatedChat.id === chatId) {
        setChat(updatedChat)
      }
    },
    onChatDeleted: ({ chatId: deletedId }) => {
      if (deletedId === chatId) {
        navigate('/chats')
      }
    },
  })

  const addFiles = useCallback((files: FileList | File[]) => {
    const images = Array.from(files).filter((file) => file.type.startsWith('image/'))
    if (images.length === 0) return
    setPendingImages((prev) => [
      ...prev,
      ...images.map((file) => ({
        id: `${file.name}-${file.size}-${Date.now()}-${Math.random()}`,
        file,
        previewUrl: URL.createObjectURL(file),
      })),
    ])
  }, [])

  useEffect(
    () => () => {
      pendingImages.forEach((pending) => URL.revokeObjectURL(pending.previewUrl))
    },
    [pendingImages],
  )

  const removePending = (idToRemove: string) => {
    setPendingImages((prev) => {
      const target = prev.find((pending) => pending.id === idToRemove)
      if (target) URL.revokeObjectURL(target.previewUrl)
      return prev.filter((pending) => pending.id !== idToRemove)
    })
  }

  const canSend = useMemo(
    () => (body.trim().length > 0 || pendingImages.length > 0) && !sending,
    [body, pendingImages.length, sending],
  )

  const handleSend = async () => {
    if (!canSend) return
    setSending(true)
    setSendError(null)
    try {
      const attachmentKeys: string[] = []
      for (const image of pendingImages) {
        const form = new FormData()
        form.append('file', image.file)
        const { data } = await client.post<UploadResponse>('/uploads', form)
        attachmentKeys.push(data.key)
      }

      const { data: createdMessage } = await client.post<ChatMessage>(`/chats/${chatId}/messages`, {
        body: body.trim() || undefined,
        attachmentKeys: attachmentKeys.length ? attachmentKeys : undefined,
      })
      setMessages((prev) => {
        if (prev.some((message) => message.id === createdMessage.id)) {
          return prev
        }
        return [...prev, createdMessage]
      })
      pendingImages.forEach((pending) => URL.revokeObjectURL(pending.previewUrl))
      setPendingImages([])
      setBody('')
    } catch {
      setSendError('Не удалось отправить сообщение')
    } finally {
      setSending(false)
    }
  }

  const startEdit = (message: ChatMessage) => {
    setEditingMessageId(message.id)
    setEditingText(message.body ?? '')
  }

  const cancelEdit = () => {
    setEditingMessageId(null)
    setEditingText('')
  }

  const saveEdit = async (messageId: number) => {
    const body = editingText.trim()
    if (!body) {
      setSendError('Текст сообщения не может быть пустым')
      return
    }
    setEditing(true)
    setSendError(null)
    try {
      const { data } = await client.patch<ChatMessage>(
        `/chats/${chatId}/messages/${messageId}/text`,
        { body },
      )
      setMessages((prev) =>
        prev.map((message) => (message.id === data.id ? data : message)),
      )
      cancelEdit()
    } catch {
      setSendError('Не удалось сохранить изменения')
    } finally {
      setEditing(false)
    }
  }

  const deleteText = async (messageId: number) => {
    setSendError(null)
    try {
      const { data } = await client.delete<ChatMessage>(
        `/chats/${chatId}/messages/${messageId}/text`,
      )
      setMessages((prev) =>
        prev.map((message) => (message.id === data.id ? data : message)),
      )
      if (editingMessageId === messageId) {
        cancelEdit()
      }
    } catch {
      setSendError('Не удалось удалить текст сообщения')
    }
  }

  const openMembersDialog = async () => {
    setMembersOpen(true)
    setMembersError(null)
    setMembersLoading(true)
    try {
      const { data } = await client.get<ChatMemberUser[]>('/chats/users')
      setAvailableUsers(data)
    } catch {
      setMembersError('Не удалось загрузить список пользователей')
    } finally {
      setMembersLoading(false)
    }
  }

  const addMember = async () => {
    if (!selectedUserId) return
    setMembersSaving(true)
    setMembersError(null)
    try {
      const { data } = await client.post<ChatListItem>(`/chats/${chatId}/members`, {
        userId: selectedUserId,
      })
      setChat(data)
      setSelectedUserId('')
    } catch {
      setMembersError('Не удалось добавить участника')
    } finally {
      setMembersSaving(false)
    }
  }

  const removeMember = async (memberUserId: number) => {
    setMembersSaving(true)
    setMembersError(null)
    try {
      const { data } = await client.delete<ChatListItem>(
        `/chats/${chatId}/members/${memberUserId}`,
      )
      setChat(data)
    } catch {
      setMembersError('Не удалось удалить участника')
    } finally {
      setMembersSaving(false)
    }
  }

  if (loading) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', py: 8 }}>
        <CircularProgress />
      </Box>
    )
  }

  if (error || !chat) {
    return (
      <Box>
        <Button startIcon={<ArrowBackIcon />} onClick={() => navigate('/chats')}>
          К чатам
        </Button>
        <Alert severity="error" sx={{ mt: 2 }}>
          {error ?? 'Чат не найден'}
        </Alert>
      </Box>
    )
  }

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2, height: 'calc(100vh - 64px - 48px)' }}>
      <Paper variant="outlined" sx={{ p: 2, borderRadius: 1.5 }}>
        <Stack direction="row" spacing={1.5} alignItems="center">
          <IconButton onClick={() => navigate('/chats')} size="small">
            <ArrowBackIcon />
          </IconButton>
          <Box sx={{ minWidth: 0 }}>
            <Stack direction="row" spacing={1} alignItems="center">
              <Typography variant="h6" sx={{ fontWeight: 800 }}>
                {chat.name}
              </Typography>
              <Chip size="small" label={chat.type === 'PUBLIC' ? 'Публичный' : 'Приватный'} />
            </Stack>
            <Typography variant="body2" color="text.secondary">
              участников: {chat.members.length}
            </Typography>
          </Box>
          {user?.role === 'ADMIN' && (
            <Button
              size="small"
              startIcon={<GroupIcon />}
              onClick={() => void openMembersDialog()}
              sx={{ ml: 'auto' }}
            >
              Участники
            </Button>
          )}
        </Stack>
      </Paper>

      <Paper variant="outlined" sx={{ flexGrow: 1, overflowY: 'auto', p: 2, borderRadius: 1.5 }}>
        {messages.length === 0 ? (
          <Box sx={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <Typography color="text.secondary">Сообщений пока нет. Начните переписку.</Typography>
          </Box>
        ) : (
          messages.map((message) => {
            const ownSide = message.author.id === user?.id
            const canEditText = ownSide || user?.role === 'ADMIN'
            const isEditing = editingMessageId === message.id
            return (
              <Box key={message.id} sx={{ display: 'flex', justifyContent: ownSide ? 'flex-end' : 'flex-start', mb: 1.5 }}>
                <Stack direction={ownSide ? 'row-reverse' : 'row'} spacing={1} sx={{ maxWidth: '80%' }}>
                  <Avatar sx={{ width: 34, height: 34, fontSize: 13 }}>{initials(message.author.name)}</Avatar>
                  <Paper variant="outlined" sx={{ p: 1.25, borderRadius: 1.5 }}>
                    <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 0.4 }}>
                      <Typography variant="caption" sx={{ fontWeight: 700 }}>
                        {message.author.name}
                      </Typography>
                      <Typography variant="caption" color="text.secondary">
                        {roleLabel(message.author.role)}
                      </Typography>
                    </Stack>
                    {isEditing ? (
                      <Stack spacing={1}>
                        <TextField
                          value={editingText}
                          onChange={(event) => setEditingText(event.target.value)}
                          multiline
                          minRows={2}
                          maxRows={6}
                          size="small"
                          autoFocus
                        />
                        <Stack direction="row" spacing={1} justifyContent="flex-end">
                          <Button size="small" onClick={cancelEdit} disabled={editing}>
                            Отмена
                          </Button>
                          <Button
                            size="small"
                            variant="contained"
                            onClick={() => void saveEdit(message.id)}
                            disabled={editing || !editingText.trim()}
                          >
                            Сохранить
                          </Button>
                        </Stack>
                      </Stack>
                    ) : message.body ? (
                      <Typography variant="body2" sx={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                        {message.body}
                      </Typography>
                    ) : (
                      <Typography variant="body2" color="text.secondary" sx={{ fontStyle: 'italic' }}>
                        Текст удален
                      </Typography>
                    )}
                    {message.attachments.length > 0 && (
                      <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1, mt: message.body ? 1 : 0 }}>
                        {message.attachments.map((attachment) => (
                          <Box
                            key={attachment.id}
                            component="img"
                            src={attachment.url}
                            alt={attachment.filename}
                            onClick={() => setLightbox(attachment.url)}
                            sx={{
                              width: 120,
                              height: 120,
                              objectFit: 'cover',
                              borderRadius: 1,
                              border: '1px solid rgba(0,0,0,0.12)',
                              cursor: 'pointer',
                            }}
                          />
                        ))}
                      </Box>
                    )}
                    <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mt: 0.4 }}>
                      {canEditText ? (
                        <Stack direction="row" spacing={0.5}>
                          {!isEditing && (
                            <Tooltip title="Редактировать текст">
                              <IconButton
                                size="small"
                                onClick={() => startEdit(message)}
                                disabled={editingMessageId != null && editingMessageId !== message.id}
                              >
                                <EditIcon sx={{ fontSize: 16 }} />
                              </IconButton>
                            </Tooltip>
                          )}
                          <Tooltip title="Удалить текст">
                            <IconButton
                              size="small"
                              onClick={() => void deleteText(message.id)}
                              disabled={isEditing}
                            >
                              <DeleteOutlineIcon sx={{ fontSize: 16 }} />
                            </IconButton>
                          </Tooltip>
                        </Stack>
                      ) : (
                        <span />
                      )}
                      <Typography variant="caption" color="text.secondary">
                        {formatTime(message.createdAt)}
                      </Typography>
                    </Stack>
                  </Paper>
                </Stack>
              </Box>
            )
          })
        )}
        <div ref={listEndRef} />
      </Paper>

      <Paper
        variant="outlined"
        onDragOver={(event) => {
          event.preventDefault()
          setDragOver(true)
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(event: DragEvent<HTMLDivElement>) => {
          event.preventDefault()
          setDragOver(false)
          if (event.dataTransfer.files.length > 0) {
            addFiles(event.dataTransfer.files)
          }
        }}
        sx={{
          p: 1.5,
          borderRadius: 1.5,
          border: dragOver ? '2px dashed' : undefined,
          borderColor: dragOver ? 'primary.main' : undefined,
        }}
      >
        {sendError && (
          <Alert severity="error" sx={{ mb: 1 }} onClose={() => setSendError(null)}>
            {sendError}
          </Alert>
        )}
        {pendingImages.length > 0 && (
          <Stack direction="row" spacing={1} sx={{ mb: 1, flexWrap: 'wrap', gap: 1 }}>
            {pendingImages.map((image) => (
              <Box key={image.id} sx={{ position: 'relative' }}>
                <Box
                  component="img"
                  src={image.previewUrl}
                  alt={image.file.name}
                  sx={{ width: 72, height: 72, objectFit: 'cover', borderRadius: 1, border: '1px solid rgba(0,0,0,0.12)' }}
                />
                <IconButton
                  size="small"
                  onClick={() => removePending(image.id)}
                  sx={{ position: 'absolute', top: -8, right: -8, bgcolor: 'background.paper', border: '1px solid rgba(0,0,0,0.12)' }}
                >
                  <CloseIcon sx={{ fontSize: 14 }} />
                </IconButton>
              </Box>
            ))}
          </Stack>
        )}
        <Stack direction="row" spacing={1} alignItems="flex-end">
          <Tooltip title="Прикрепить фото">
            <IconButton onClick={() => fileInputRef.current?.click()}>
              <ImageIcon />
            </IconButton>
          </Tooltip>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            multiple
            hidden
            onChange={(event) => {
              if (event.target.files) addFiles(event.target.files)
              event.target.value = ''
            }}
          />
          <TextField
            placeholder="Напишите сообщение..."
            value={body}
            onChange={(event) => setBody(event.target.value)}
            multiline
            maxRows={6}
            fullWidth
            size="small"
            onKeyDown={(event) => {
              if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
                event.preventDefault()
                void handleSend()
              }
            }}
          />
          <Button
            variant="contained"
            onClick={() => void handleSend()}
            disabled={!canSend}
            endIcon={sending ? <CircularProgress size={16} color="inherit" /> : <SendIcon />}
          >
            Отправить
          </Button>
        </Stack>
      </Paper>

      {lightbox && (
        <Box
          onClick={() => setLightbox(null)}
          sx={{
            position: 'fixed',
            inset: 0,
            bgcolor: 'rgba(0,0,0,0.85)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 1400,
            p: 2,
          }}
        >
          <IconButton onClick={() => setLightbox(null)} sx={{ position: 'absolute', top: 16, right: 16, color: '#fff' }}>
            <CloseIcon />
          </IconButton>
          <Box component="img" src={lightbox} alt="attachment" sx={{ maxWidth: '95%', maxHeight: '95%', objectFit: 'contain', borderRadius: 1 }} />
        </Box>
      )}

      <Dialog
        open={membersOpen}
        onClose={() => !membersSaving && setMembersOpen(false)}
        fullWidth
        maxWidth="sm"
      >
        <DialogTitle>Участники чата</DialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={{ mt: 1 }}>
            {membersError && <Alert severity="error">{membersError}</Alert>}
            {membersLoading ? (
              <Box sx={{ display: 'flex', justifyContent: 'center', py: 2 }}>
                <CircularProgress size={24} />
              </Box>
            ) : (
              <>
                <Stack direction="row" spacing={1} alignItems="center">
                  <TextField
                    select
                    size="small"
                    label="Добавить пользователя"
                    value={selectedUserId === '' ? '' : String(selectedUserId)}
                    onChange={(event) =>
                      setSelectedUserId(
                        event.target.value ? Number(event.target.value) : '',
                      )
                    }
                    sx={{ flexGrow: 1 }}
                  >
                    {availableUsers.map((candidate) => (
                      <MenuItem key={candidate.id} value={String(candidate.id)}>
                        {candidate.name} ({candidate.username})
                      </MenuItem>
                    ))}
                  </TextField>
                  <Button
                    variant="contained"
                    onClick={() => void addMember()}
                    disabled={!selectedUserId || membersSaving}
                  >
                    Добавить
                  </Button>
                </Stack>
                <List dense>
                  {chat.members.map((member) => (
                    <ListItem
                      key={member.userId}
                      secondaryAction={
                        chat.createdById !== member.userId ? (
                          <Button
                            size="small"
                            color="error"
                            onClick={() => void removeMember(member.userId)}
                            disabled={membersSaving}
                          >
                            Удалить
                          </Button>
                        ) : undefined
                      }
                    >
                      <ListItemText
                        primary={member.user.name}
                        secondary={`${member.user.username} • ${roleLabel(member.user.role)}`}
                      />
                    </ListItem>
                  ))}
                </List>
              </>
            )}
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setMembersOpen(false)} disabled={membersSaving}>
            Закрыть
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  )
}
