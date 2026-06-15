import { Injectable, NotFoundException, ConflictException } from '@nestjs/common';
import { OrderStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CreateOrderDto } from './dto/create-order.dto';
import { UpdateOrderDto } from './dto/update-order.dto';

@Injectable()
export class OrdersService {
  constructor(private prisma: PrismaService) {}

  async findAll(status?: OrderStatus, q?: string, page = 1, limit = 30) {
    const where: Prisma.OrderWhereInput = {};
    if (status) {
      where.status = status;
    }
    if (q && q.trim()) {
      where.OR = [
        { orderNumber: { contains: q, mode: 'insensitive' } },
        { title: { contains: q, mode: 'insensitive' } },
      ];
    }

    const safeLimit = Math.min(Math.max(Math.trunc(limit) || 30, 1), 100);
    const safePage = Math.max(Math.trunc(page) || 1, 1);

    const [total, orders] = await Promise.all([
      this.prisma.order.count({ where }),
      this.prisma.order.findMany({
        where,
        orderBy: { updatedAt: 'desc' },
        skip: (safePage - 1) * safeLimit,
        take: safeLimit,
      }),
    ]);

    const items = await Promise.all(orders.map((o) => this.withStats(o)));

    return {
      items,
      total,
      page: safePage,
      limit: safeLimit,
      totalPages: Math.max(Math.ceil(total / safeLimit), 1),
    };
  }

  async findOne(id: number) {
    const order = await this.prisma.order.findUnique({
      where: { id },
      include: {
        lead: {
          select: {
            id: true,
            bsCustomerId: true,
            name: true,
            fullName: true,
            vkDialogUrl: true,
            vkUserId: true,
            crmStatus: true,
            lastSyncedAt: true,
          },
        },
        bluesalesInfo: {
          select: {
            bsOrderId: true,
            bsNumber: true,
            orderStatus: true,
            orderStatusId: true,
            crmStatus: true,
            crmStatusId: true,
            totalSum: true,
            bsCreatedAt: true,
            lastSyncedAt: true,
          },
        },
      },
    });
    if (!order) {
      throw new NotFoundException('Заказ не найден');
    }
    const base = await this.withStats(order);
    return {
      ...base,
      source: order.source,
      lead: order.lead,
      bluesalesInfo: order.bluesalesInfo,
    };
  }

  async create(dto: CreateOrderDto) {
    const existing = await this.prisma.order.findUnique({
      where: { orderNumber: dto.orderNumber },
    });
    if (existing) {
      throw new ConflictException('Заказ с таким номером уже существует');
    }
    const order = await this.prisma.order.create({
      data: { orderNumber: dto.orderNumber, title: dto.title },
    });
    return this.withStats(order);
  }

  async update(id: number, dto: UpdateOrderDto) {
    const existing = await this.prisma.order.findUnique({ where: { id } });
    if (!existing) {
      throw new NotFoundException('Заказ не найден');
    }

    const data: Prisma.OrderUpdateInput = {};

    if (dto.status !== undefined) {
      data.status = dto.status;
    }

    if (dto.orderNumber !== undefined) {
      const orderNumber = dto.orderNumber.trim();
      if (orderNumber !== existing.orderNumber) {
        const conflict = await this.prisma.order.findUnique({
          where: { orderNumber },
        });
        if (conflict) {
          throw new ConflictException('Заказ с таким номером уже существует');
        }
      }
      data.orderNumber = orderNumber;
    }

    if (dto.title !== undefined) {
      const title = dto.title.trim();
      data.title = title.length > 0 ? title : null;
    }

    const order = await this.prisma.order.update({
      where: { id },
      data,
    });
    return this.withStats(order);
  }

  async getMetrics(id: number) {
    await this.findOne(id);
    return this.computeStats(id);
  }

  private async withStats(order: {
    id: number;
    orderNumber: string;
    title: string | null;
    status: OrderStatus;
    createdAt: Date;
  }) {
    const stats = await this.computeStats(order.id);
    const last = await this.prisma.message.findFirst({
      where: { orderId: order.id },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true },
    });
    return {
      id: order.id,
      orderNumber: order.orderNumber,
      title: order.title,
      status: order.status,
      revisionCount: stats.revisionCount,
      openRevisions: stats.openRevisions,
      avgRevisionSeconds: stats.avgRevisionSeconds,
      lastMessageAt: last?.createdAt ?? null,
      createdAt: order.createdAt,
    };
  }

  private async computeStats(orderId: number) {
    const revisionCount = await this.prisma.message.count({
      where: { orderId, kind: 'REVISION_REQUEST' },
    });
    const openRevisions = await this.prisma.message.count({
      where: { orderId, kind: 'REVISION_REQUEST', answeredBy: { none: {} } },
    });

    // Average revision duration: for each answer, time between request and answer.
    const answers = await this.prisma.message.findMany({
      where: { orderId, kind: 'REVISION_ANSWER', answerToId: { not: null } },
      select: { createdAt: true, answerTo: { select: { createdAt: true } } },
    });
    const durations = answers
      .filter((a) => a.answerTo)
      .map((a) => (a.createdAt.getTime() - a.answerTo!.createdAt.getTime()) / 1000)
      .filter((s) => s >= 0);
    const avgRevisionSeconds =
      durations.length > 0
        ? Math.round(durations.reduce((sum, s) => sum + s, 0) / durations.length)
        : null;

    return { revisionCount, openRevisions, avgRevisionSeconds };
  }
}
