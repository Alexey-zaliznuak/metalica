import { useEffect, useRef } from 'react'
import { io, type Socket } from 'socket.io-client'
import type { ChatListItem, ChatMessage } from '../api/types'

interface UseChatSocketParams {
  token: string | null
  chatId: number | null
  onMessageCreated: (message: ChatMessage) => void
  onMessageUpdated?: (message: ChatMessage) => void
  onChatUpdated?: (chat: ChatListItem) => void
  onChatDeleted?: (payload: { chatId: number }) => void
}

export function useChatSocket({
  token,
  chatId,
  onMessageCreated,
  onMessageUpdated,
  onChatUpdated,
  onChatDeleted,
}: UseChatSocketParams) {
  const socketRef = useRef<Socket | null>(null)

  useEffect(() => {
    if (!token) return

    const socket = io('/', {
      path: '/socket.io',
      transports: ['websocket'],
      auth: { token },
    })

    socket.on('chat:message_created', onMessageCreated)
    if (onMessageUpdated) socket.on('chat:message_updated', onMessageUpdated)
    if (onChatUpdated) socket.on('chat:updated', onChatUpdated)
    if (onChatDeleted) socket.on('chat:deleted', onChatDeleted)

    if (chatId != null) {
      socket.emit('chat:join', { chatId })
    }

    socketRef.current = socket

    return () => {
      if (chatId != null) {
        socket.emit('chat:leave', { chatId })
      }
      socket.off('chat:message_created', onMessageCreated)
      if (onMessageUpdated) socket.off('chat:message_updated', onMessageUpdated)
      if (onChatUpdated) socket.off('chat:updated', onChatUpdated)
      if (onChatDeleted) socket.off('chat:deleted', onChatDeleted)
      socket.disconnect()
      socketRef.current = null
    }
  }, [chatId, onChatDeleted, onChatUpdated, onMessageCreated, onMessageUpdated, token])
}
