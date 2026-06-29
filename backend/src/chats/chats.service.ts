import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ChatMemberRole, ChatType, Prisma, Role } from '@prisma/client';
import { AuthUser } from '../auth/current-user.decorator';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from '../storage/storage.service';
import { ChatsGateway } from '../realtime/chats.gateway';
import { AddChatMemberDto } from './dto/add-chat-member.dto';
import { CreateChatDto } from './dto/create-chat.dto';
import { CreateChatMessageDto } from './dto/create-chat-message.dto';
import { UpdateChatDto } from './dto/update-chat.dto';
import { UpdateChatMessageTextDto } from './dto/update-chat-message-text.dto';

const chatInclude = {
  members: {
    include: {
      user: { select: { id: true, username: true, name: true, role: true } },
    },
    orderBy: { createdAt: 'asc' },
  },
  messages: {
    orderBy: { createdAt: 'desc' },
    take: 1,
    include: {
      author: { select: { id: true, name: true, role: true } },
    },
  },
} satisfies Prisma.ChatInclude;

const chatMessageInclude = {
  author: { select: { id: true, name: true, role: true } },
  attachments: true,
} satisfies Prisma.ChatMessageInclude;

type ChatWithRelations = Prisma.ChatGetPayload<{ include: typeof chatInclude }>;
type ChatMessageWithRelations = Prisma.ChatMessageGetPayload<{
  include: typeof chatMessageInclude;
}>;

@Injectable()
export class ChatsService {
  constructor(
    private prisma: PrismaService,
    private storage: StorageService,
    private gateway: ChatsGateway,
  ) {}

  async list(currentUser: AuthUser) {
    const chats = await this.prisma.chat.findMany({
      where: {
        OR: [{ type: ChatType.PUBLIC }, { members: { some: { userId: currentUser.id } } }],
      },
      include: chatInclude,
      orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
    });
    return chats.map((chat) => this.serializeChat(chat));
  }

  async getOne(chatId: number, currentUser: AuthUser) {
    await this.ensureCanAccess(chatId, currentUser.id);
    const chat = await this.prisma.chat.findUnique({
      where: { id: chatId },
      include: chatInclude,
    });
    if (!chat) {
      throw new NotFoundException('Чат не найден');
    }
    return this.serializeChat(chat);
  }

  async create(dto: CreateChatDto, currentUser: AuthUser) {
    const uniqueMemberIds = Array.from(new Set([currentUser.id, ...(dto.memberIds ?? [])]));

    const chat = await this.prisma.chat.create({
      data: {
        name: dto.name.trim(),
        type: dto.type ?? ChatType.PUBLIC,
        createdById: currentUser.id,
        members: {
          create: uniqueMemberIds.map((memberId) => ({
            userId: memberId,
            role: memberId === currentUser.id ? ChatMemberRole.MODERATOR : ChatMemberRole.MEMBER,
          })),
        },
      },
      include: chatInclude,
    });

    const serialized = this.serializeChat(chat);
    this.gateway.emitChatUpdated(serialized);
    return serialized;
  }

  async update(chatId: number, dto: UpdateChatDto, currentUser: AuthUser) {
    await this.ensureCanManage(chatId, currentUser);

    const data: Prisma.ChatUpdateInput = {};
    if (dto.name !== undefined) {
      const trimmed = dto.name.trim();
      if (!trimmed) {
        throw new BadRequestException('Название чата не может быть пустым');
      }
      data.name = trimmed;
    }
    if (dto.type !== undefined) {
      data.type = dto.type;
    }
    if (Object.keys(data).length === 0) {
      throw new BadRequestException('Нет данных для обновления');
    }

    const chat = await this.prisma.chat.update({
      where: { id: chatId },
      data,
      include: chatInclude,
    });

    const serialized = this.serializeChat(chat);
    this.gateway.emitChatUpdated(serialized);
    return serialized;
  }

  async remove(chatId: number, currentUser: AuthUser) {
    await this.ensureCanManage(chatId, currentUser);
    await this.prisma.chat.delete({ where: { id: chatId } });
    this.gateway.emitChatDeleted(chatId);
    return { ok: true };
  }

  async addMember(chatId: number, dto: AddChatMemberDto, currentUser: AuthUser) {
    await this.ensureCanManage(chatId, currentUser);

    const targetUser = await this.prisma.user.findUnique({ where: { id: dto.userId } });
    if (!targetUser) {
      throw new NotFoundException('Пользователь не найден');
    }

    await this.prisma.chatMember.upsert({
      where: { chatId_userId: { chatId, userId: dto.userId } },
      create: {
        chatId,
        userId: dto.userId,
        role: dto.role ?? ChatMemberRole.MEMBER,
      },
      update: {
        role: dto.role ?? undefined,
      },
    });

    const chat = await this.prisma.chat.update({
      where: { id: chatId },
      data: { updatedAt: new Date() },
      include: chatInclude,
    });

    const serialized = this.serializeChat(chat);
    this.gateway.emitChatUpdated(serialized);
    return serialized;
  }

  async removeMember(chatId: number, memberUserId: number, currentUser: AuthUser) {
    await this.ensureCanManage(chatId, currentUser);

    const chat = await this.prisma.chat.findUnique({
      where: { id: chatId },
      select: { createdById: true },
    });
    if (!chat) {
      throw new NotFoundException('Чат не найден');
    }
    if (chat.createdById === memberUserId) {
      throw new BadRequestException('Нельзя удалить создателя чата');
    }

    await this.prisma.chatMember.deleteMany({
      where: { chatId, userId: memberUserId },
    });

    const updated = await this.prisma.chat.update({
      where: { id: chatId },
      data: { updatedAt: new Date() },
      include: chatInclude,
    });

    const serialized = this.serializeChat(updated);
    this.gateway.emitChatUpdated(serialized);
    return serialized;
  }

  async listMessages(chatId: number, currentUserId: number) {
    await this.ensureCanAccess(chatId, currentUserId);
    const messages = await this.prisma.chatMessage.findMany({
      where: { chatId },
      orderBy: { createdAt: 'asc' },
      include: chatMessageInclude,
    });
    return Promise.all(messages.map((message) => this.serializeMessage(message)));
  }

  async createMessage(chatId: number, authorId: number, dto: CreateChatMessageDto) {
    await this.ensureCanAccess(chatId, authorId);
    const hasContent = (dto.body && dto.body.trim()) || (dto.attachmentKeys?.length ?? 0) > 0;
    if (!hasContent) {
      throw new BadRequestException('Сообщение не может быть пустым');
    }

    const message = await this.prisma.$transaction(async (tx) => {
      const created = await tx.chatMessage.create({
        data: {
          chatId,
          authorId,
          body: dto.body?.trim() || null,
          attachments: dto.attachmentKeys?.length
            ? {
                create: dto.attachmentKeys.map((key) => ({
                  objectKey: key,
                  filename: key.substring(key.lastIndexOf('/') + 1),
                  kind: 'attachment',
                })),
              }
            : undefined,
        },
        include: chatMessageInclude,
      });
      await tx.chat.update({
        where: { id: chatId },
        data: { updatedAt: new Date() },
      });
      return created;
    });

    const serialized = await this.serializeMessage(message);
    this.gateway.emitMessageCreated(chatId, serialized);
    return serialized;
  }

  async updateMessageText(
    chatId: number,
    messageId: number,
    currentUser: AuthUser,
    dto: UpdateChatMessageTextDto,
  ) {
    await this.ensureCanAccess(chatId, currentUser.id);
    const message = await this.prisma.chatMessage.findFirst({
      where: { id: messageId, chatId },
      select: { id: true, authorId: true },
    });
    if (!message) {
      throw new NotFoundException('Сообщение не найдено');
    }
    if (currentUser.role !== 'ADMIN' && message.authorId !== currentUser.id) {
      throw new ForbiddenException('Можно редактировать только свои сообщения');
    }
    const body = dto.body.trim();
    if (!body) {
      throw new BadRequestException('Текст сообщения не может быть пустым');
    }
    const updated = await this.prisma.chatMessage.update({
      where: { id: messageId },
      data: { body },
      include: chatMessageInclude,
    });
    const serialized = await this.serializeMessage(updated);
    this.gateway.emitMessageUpdated(chatId, serialized);
    return serialized;
  }

  async deleteMessageText(chatId: number, messageId: number, currentUser: AuthUser) {
    await this.ensureCanAccess(chatId, currentUser.id);
    const message = await this.prisma.chatMessage.findFirst({
      where: { id: messageId, chatId },
      select: { id: true, authorId: true },
    });
    if (!message) {
      throw new NotFoundException('Сообщение не найдено');
    }
    if (currentUser.role !== 'ADMIN' && message.authorId !== currentUser.id) {
      throw new ForbiddenException('Можно удалять текст только своих сообщений');
    }
    const updated = await this.prisma.chatMessage.update({
      where: { id: messageId },
      data: { body: null },
      include: chatMessageInclude,
    });
    const serialized = await this.serializeMessage(updated);
    this.gateway.emitMessageUpdated(chatId, serialized);
    return serialized;
  }

  async listUsers() {
    const users = await this.prisma.user.findMany({
      select: { id: true, username: true, name: true, role: true },
      orderBy: [{ name: 'asc' }],
    });
    return users.map((user) => ({
      ...user,
      role: user.role as Role,
    }));
  }

  async canAccessForSocket(chatId: number, userId: number) {
    const chat = await this.prisma.chat.findUnique({
      where: { id: chatId },
      select: {
        type: true,
        members: { where: { userId }, select: { id: true } },
      },
    });
    if (!chat) {
      return false;
    }
    return chat.type === ChatType.PUBLIC || chat.members.length > 0;
  }

  private serializeChat(chat: ChatWithRelations) {
    const lastMessage = chat.messages[0] ?? null;
    return {
      id: chat.id,
      name: chat.name,
      type: chat.type,
      createdById: chat.createdById,
      createdAt: chat.createdAt,
      updatedAt: chat.updatedAt,
      members: chat.members.map((member) => ({
        userId: member.userId,
        role: member.role,
        joinedAt: member.createdAt,
        user: member.user,
      })),
      lastMessageAt: lastMessage?.createdAt ?? null,
      lastMessage: lastMessage
        ? {
            id: lastMessage.id,
            body: lastMessage.body,
            createdAt: lastMessage.createdAt,
            author: lastMessage.author,
          }
        : null,
    };
  }

  private async serializeMessage(message: ChatMessageWithRelations) {
    const attachments = await Promise.all(
      message.attachments.map(async (attachment) => ({
        id: attachment.id,
        url: await this.storage.getUrl(attachment.objectKey),
        filename: attachment.filename,
        mimeType: attachment.mimeType,
        kind: attachment.kind,
      })),
    );

    return {
      id: message.id,
      chatId: message.chatId,
      body: message.body,
      createdAt: message.createdAt,
      updatedAt: message.updatedAt,
      author: message.author,
      attachments,
    };
  }

  private async ensureCanAccess(chatId: number, userId: number) {
    const canAccess = await this.canAccessForSocket(chatId, userId);
    if (!canAccess) {
      throw new ForbiddenException('Нет доступа к этому чату');
    }
  }

  private async ensureCanManage(chatId: number, currentUser: AuthUser) {
    const chat = await this.prisma.chat.findUnique({
      where: { id: chatId },
      select: {
        id: true,
        createdById: true,
        members: {
          where: { userId: currentUser.id },
          select: { role: true },
        },
      },
    });
    if (!chat) {
      throw new NotFoundException('Чат не найден');
    }
    const isAdmin = currentUser.role === 'ADMIN';
    const isCreator = chat.createdById === currentUser.id;
    const isModerator = chat.members.some((member) => member.role === ChatMemberRole.MODERATOR);
    if (!isAdmin && !isCreator && !isModerator) {
      throw new ForbiddenException('Недостаточно прав для управления чатом');
    }
  }
}
