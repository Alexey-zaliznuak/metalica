import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { MessageKind, Prisma } from '@prisma/client';
import { AuthUser } from '../auth/current-user.decorator';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from '../storage/storage.service';
import { CreateMessageDto } from './dto/create-message.dto';
import { UpdateMessageTextDto } from './dto/update-message-text.dto';

const messageInclude = {
  author: { select: { id: true, name: true, role: true } },
  attachments: true,
  answerTo: { select: { id: true, createdAt: true, body: true } },
} satisfies Prisma.MessageInclude;

type MessageWithRelations = Prisma.MessageGetPayload<{ include: typeof messageInclude }>;

@Injectable()
export class MessagesService {
  constructor(
    private prisma: PrismaService,
    private storage: StorageService,
  ) {}

  async list(orderId: number) {
    await this.ensureOrder(orderId);
    const messages = await this.prisma.message.findMany({
      where: { orderId },
      orderBy: { createdAt: 'asc' },
      include: messageInclude,
    });
    return Promise.all(messages.map((m) => this.serialize(m)));
  }

  async create(orderId: number, authorId: number, dto: CreateMessageDto) {
    await this.ensureOrder(orderId);

    const hasContent = (dto.body && dto.body.trim()) || (dto.attachmentKeys?.length ?? 0) > 0;
    if (!hasContent) {
      throw new BadRequestException('Сообщение не может быть пустым');
    }

    let answerToId: number | null = dto.answerToId ?? null;

    // Auto-pair an answer to the latest still-open revision request.
    if (dto.kind === MessageKind.REVISION_ANSWER && !answerToId) {
      const openRequest = await this.prisma.message.findFirst({
        where: { orderId, kind: MessageKind.REVISION_REQUEST, answeredBy: { none: {} } },
        orderBy: { createdAt: 'desc' },
        select: { id: true },
      });
      answerToId = openRequest?.id ?? null;
    }

    if (answerToId) {
      const target = await this.prisma.message.findFirst({
        where: { id: answerToId, orderId },
      });
      if (!target) {
        throw new BadRequestException('Запрос правки для ответа не найден в этом заказе');
      }
    }

    const message = await this.prisma.message.create({
      data: {
        orderId,
        authorId,
        kind: dto.kind,
        body: dto.body?.trim() || null,
        answerToId,
        attachments: dto.attachmentKeys?.length
          ? {
              create: dto.attachmentKeys.map((key) => ({
                objectKey: key,
                filename: key.substring(key.lastIndexOf('/') + 1),
                kind: dto.kind === MessageKind.REVISION_ANSWER ? 'revision' : 'attachment',
              })),
            }
          : undefined,
      },
      include: messageInclude,
    });

    return this.serialize(message);
  }

  async updateText(
    orderId: number,
    messageId: number,
    currentUser: AuthUser,
    dto: UpdateMessageTextDto,
  ) {
    await this.ensureOrder(orderId);
    const existing = await this.prisma.message.findFirst({
      where: { id: messageId, orderId },
      select: { id: true, authorId: true },
    });
    if (!existing) {
      throw new NotFoundException('Сообщение не найдено');
    }
    if (currentUser.role !== 'ADMIN' && existing.authorId !== currentUser.id) {
      throw new ForbiddenException('Можно редактировать только свои сообщения');
    }
    const body = dto.body.trim();
    if (!body) {
      throw new BadRequestException('Текст сообщения не может быть пустым');
    }
    const updated = await this.prisma.message.update({
      where: { id: messageId },
      data: { body },
      include: messageInclude,
    });
    return this.serialize(updated);
  }

  async deleteText(orderId: number, messageId: number, currentUser: AuthUser) {
    await this.ensureOrder(orderId);
    const existing = await this.prisma.message.findFirst({
      where: { id: messageId, orderId },
      select: { id: true, authorId: true },
    });
    if (!existing) {
      throw new NotFoundException('Сообщение не найдено');
    }
    if (currentUser.role !== 'ADMIN' && existing.authorId !== currentUser.id) {
      throw new ForbiddenException('Можно удалять текст только своих сообщений');
    }
    const updated = await this.prisma.message.update({
      where: { id: messageId },
      data: { body: null },
      include: messageInclude,
    });
    return this.serialize(updated);
  }

  private async serialize(m: MessageWithRelations) {
    const attachments = await Promise.all(
      m.attachments.map(async (a) => ({
        id: a.id,
        url: await this.storage.getUrl(a.objectKey),
        filename: a.filename,
        mimeType: a.mimeType,
        kind: a.kind,
      })),
    );

    return {
      id: m.id,
      orderId: m.orderId,
      kind: m.kind,
      body: m.body,
      createdAt: m.createdAt,
      author: m.author,
      answerToId: m.answerToId,
      answerTo: m.answerTo,
      attachments,
    };
  }

  private async ensureOrder(orderId: number) {
    const order = await this.prisma.order.findUnique({ where: { id: orderId } });
    if (!order) {
      throw new NotFoundException('Заказ не найден');
    }
  }
}
