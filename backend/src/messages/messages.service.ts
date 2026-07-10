import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AuthUser } from '../auth/current-user.decorator';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from '../storage/storage.service';
import { CreateMessageDto } from './dto/create-message.dto';
import { UpdateMessageTextDto } from './dto/update-message-text.dto';
import { MessageKind } from './message-kind';

const messageInclude = {
  author: { select: { id: true, name: true, role: true } },
  attachments: true,
  // Наличие revision -> запрос правки; наличие revisionClosure -> ответ/закрытие.
  revision: { select: { id: true, closure: { select: { id: true } } } },
  revisionClosure: {
    select: {
      id: true,
      revision: {
        select: {
          messageId: true,
          message: { select: { id: true, createdAt: true, body: true } },
        },
      },
    },
  },
} satisfies Prisma.MessageInclude;

type MessageWithRelations = Prisma.MessageGetPayload<{ include: typeof messageInclude }>;

@Injectable()
export class MessagesService {
  constructor(
    private prisma: PrismaService,
    private storage: StorageService,
  ) {}

  async list(orderId: number, options: { limit?: number; before?: number } = {}) {
    await this.ensureOrder(orderId);
    const limit = Math.min(Math.max(options.limit ?? 30, 1), 100);
    const rows = await this.prisma.message.findMany({
      where: {
        orderId,
        ...(options.before ? { id: { lt: options.before } } : {}),
      },
      orderBy: { id: 'desc' },
      take: limit + 1,
      include: messageInclude,
    });
    const hasMore = rows.length > limit;
    const slice = hasMore ? rows.slice(0, limit) : rows;
    const nextCursor = hasMore ? slice[slice.length - 1].id : null;
    const ordered = [...slice].reverse();
    const items = await Promise.all(ordered.map((m) => this.serialize(m)));
    return { items, nextCursor, hasMore };
  }

  async create(orderId: number, authorId: number, dto: CreateMessageDto) {
    await this.ensureOrder(orderId);

    const hasContent = (dto.body && dto.body.trim()) || (dto.attachmentKeys?.length ?? 0) > 0;
    if (!hasContent) {
      throw new BadRequestException('Сообщение не может быть пустым');
    }

    const body = dto.body?.trim() || null;
    const buildAttachments = (attachmentKind: string) =>
      dto.attachmentKeys?.length
        ? {
            create: dto.attachmentKeys.map((key) => ({
              objectKey: key,
              filename: key.substring(key.lastIndexOf('/') + 1),
              kind: attachmentKind,
            })),
          }
        : undefined;

    // Запрос правки: сообщение + связанная (пустая) модель Revision.
    if (dto.kind === MessageKind.REVISION_REQUEST) {
      // Нельзя открывать новую правку, пока не закрыта предыдущая: иначе
      // теряется однозначная связь «правка -> закрытие» и портится аналитика.
      const openRevision = await this.prisma.revision.findFirst({
        where: { orderId, closure: { is: null } },
        select: { id: true },
      });
      if (openRevision) {
        throw new BadRequestException(
          'По заказу уже есть незакрытая правка. Дождитесь её закрытия, ' +
            'а новые детали добавьте, отредактировав запрос правки или отправив обычное сообщение.',
        );
      }

      const message = await this.prisma.message.create({
        data: {
          orderId,
          authorId,
          body,
          attachments: buildAttachments('attachment'),
          revision: { create: { orderId } },
        },
        include: messageInclude,
      });
      return this.serialize(message);
    }

    // Ответ/закрытие правки: находим открытую правку и создаём RevisionClosure
    // с денормализацией (кто закрыл + время открытия/закрытия).
    if (dto.kind === MessageKind.REVISION_ANSWER) {
      const revision = dto.answerToId
        ? await this.prisma.revision.findFirst({
            where: { orderId, messageId: dto.answerToId, closure: { is: null } },
            select: { id: true, openedAt: true },
          })
        : await this.prisma.revision.findFirst({
            where: { orderId, closure: { is: null } },
            orderBy: { openedAt: 'desc' },
            select: { id: true, openedAt: true },
          });

      if (!revision) {
        throw new BadRequestException('Нет открытой правки для закрытия в этом заказе');
      }

      const message = await this.prisma.message.create({
        data: {
          orderId,
          authorId,
          body,
          attachments: buildAttachments('revision'),
          revisionClosure: {
            create: {
              revisionId: revision.id,
              closedById: authorId,
              openedAt: revision.openedAt,
            },
          },
        },
        include: messageInclude,
      });
      return this.serialize(message);
    }

    // Обычное сообщение.
    const message = await this.prisma.message.create({
      data: {
        orderId,
        authorId,
        body,
        attachments: buildAttachments('attachment'),
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

    const kind = m.revision
      ? MessageKind.REVISION_REQUEST
      : m.revisionClosure
        ? MessageKind.REVISION_ANSWER
        : MessageKind.NORMAL;

    const answerToMessage = m.revisionClosure?.revision?.message ?? null;

    return {
      id: m.id,
      orderId: m.orderId,
      kind,
      body: m.body,
      createdAt: m.createdAt,
      author: m.author,
      answerToId: m.revisionClosure?.revision?.messageId ?? null,
      answerTo: answerToMessage
        ? {
            id: answerToMessage.id,
            createdAt: answerToMessage.createdAt,
            body: answerToMessage.body,
          }
        : null,
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
