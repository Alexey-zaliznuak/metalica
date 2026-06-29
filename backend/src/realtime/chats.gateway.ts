import {
  ConnectedSocket,
  MessageBody,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
  WsException,
} from '@nestjs/websockets';
import { Injectable, OnModuleInit } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ChatType } from '@prisma/client';
import { Server, Socket } from 'socket.io';
import { PrismaService } from '../prisma/prisma.service';

interface JwtPayload {
  sub: number;
}

interface AuthenticatedSocket extends Socket {
  data: Socket['data'] & { userId?: number };
}

function roomName(chatId: number): string {
  return `chat:${chatId}`;
}

@Injectable()
@WebSocketGateway({
  cors: { origin: true, credentials: true },
})
export class ChatsGateway implements OnModuleInit {
  @WebSocketServer()
  server: Server;

  constructor(
    private jwtService: JwtService,
    private prisma: PrismaService,
  ) {}

  onModuleInit() {
    this.server.use(async (socket: AuthenticatedSocket, next) => {
      try {
        const token = this.extractToken(socket);
        if (!token) {
          next(new Error('Unauthorized'));
          return;
        }
        const payload = await this.jwtService.verifyAsync<JwtPayload>(token, {
          secret: process.env.JWT_SECRET || 'dev-secret-change-me',
        });
        const user = await this.prisma.user.findUnique({
          where: { id: payload.sub },
          select: { id: true },
        });
        if (!user) {
          next(new Error('Unauthorized'));
          return;
        }
        socket.data.userId = user.id;
        next();
      } catch {
        next(new Error('Unauthorized'));
      }
    });
  }

  @SubscribeMessage('chat:join')
  async joinChat(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody() payload: { chatId?: number },
  ) {
    const chatId = Number(payload?.chatId);
    if (!Number.isFinite(chatId)) {
      throw new WsException('Некорректный chatId');
    }
    const userId = client.data.userId;
    if (!userId) {
      throw new WsException('Не авторизован');
    }
    const chat = await this.prisma.chat.findUnique({
      where: { id: chatId },
      select: {
        type: true,
        members: {
          where: { userId },
          select: { id: true },
        },
      },
    });
    const canAccess =
      !!chat && (chat.type === ChatType.PUBLIC || chat.members.length > 0);
    if (!canAccess) {
      throw new WsException('Нет доступа к чату');
    }
    await client.join(roomName(chatId));
    return { ok: true, chatId };
  }

  @SubscribeMessage('chat:leave')
  async leaveChat(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody() payload: { chatId?: number },
  ) {
    const chatId = Number(payload?.chatId);
    if (!Number.isFinite(chatId)) {
      throw new WsException('Некорректный chatId');
    }
    await client.leave(roomName(chatId));
    return { ok: true, chatId };
  }

  emitMessageCreated(chatId: number, message: unknown) {
    this.server.to(roomName(chatId)).emit('chat:message_created', message);
  }

  emitMessageUpdated(chatId: number, message: unknown) {
    this.server.to(roomName(chatId)).emit('chat:message_updated', message);
  }

  emitChatUpdated(chat: unknown) {
    this.server.emit('chat:updated', chat);
  }

  emitChatDeleted(chatId: number) {
    this.server.emit('chat:deleted', { chatId });
  }

  private extractToken(socket: AuthenticatedSocket): string | null {
    const authToken =
      typeof socket.handshake.auth?.token === 'string' ? socket.handshake.auth.token : null;
    if (authToken) {
      return authToken;
    }
    const header = socket.handshake.headers.authorization;
    if (!header) {
      return null;
    }
    const [type, token] = header.split(' ');
    if (type?.toLowerCase() !== 'bearer' || !token) {
      return null;
    }
    return token;
  }
}
