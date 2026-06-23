import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { OrderSource, Prisma, Role, UserScope } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CreateOrderDto } from './dto/create-order.dto';
import { UpdateOrderDto } from './dto/update-order.dto';
import { BluesalesApiService } from '../bluesales/bluesales-api.service';
import { AuthUser } from '../auth/current-user.decorator';

@Injectable()
export class OrdersService {
  constructor(
    private prisma: PrismaService,
    private bluesalesApi: BluesalesApiService,
  ) {}

  private readonly userSelect = {
    id: true,
    name: true,
    username: true,
    role: true,
  } as const;

  async findAll(
    bsStatusId?: number,
    crmStatusIdsRaw?: string,
    q?: string,
    page = 1,
    limit = 30,
  ) {
    const where: Prisma.OrderWhereInput = {};
    if (bsStatusId !== undefined && Number.isFinite(bsStatusId)) {
      where.bluesalesInfo = { is: { orderStatusId: bsStatusId } };
    }
    const crmStatusIds = this.parseStatusIds(crmStatusIdsRaw);
    if (crmStatusIds.length > 0) {
      where.bluesalesInfo = {
        is: {
          ...(where.bluesalesInfo && 'is' in where.bluesalesInfo
            ? where.bluesalesInfo.is
            : {}),
          crmStatusId: { in: crmStatusIds },
        },
      };
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
        include: {
          deliveryManager: { select: this.userSelect },
          onboardingManager: { select: this.userSelect },
          sketchDesigner: { select: this.userSelect },
          revisionDesigner: { select: this.userSelect },
          bluesalesInfo: {
            select: {
              orderStatusId: true,
              orderStatus: true,
              crmStatusId: true,
              crmStatus: true,
            },
          },
        },
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
        deliveryManager: { select: this.userSelect },
        onboardingManager: { select: this.userSelect },
        sketchDesigner: { select: this.userSelect },
        revisionDesigner: { select: this.userSelect },
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
      deliveryManager: order.deliveryManager,
      onboardingManager: order.onboardingManager,
      sketchDesigner: order.sketchDesigner,
      revisionDesigner: order.revisionDesigner,
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

  async update(id: number, dto: UpdateOrderDto, actor: AuthUser) {
    const existing = await this.prisma.order.findUnique({ where: { id } });
    if (!existing) {
      throw new NotFoundException('Заказ не найден');
    }

    const touchesResponsible = this.touchesResponsibleFields(dto);
    if (touchesResponsible && !this.canChangeResponsible(actor)) {
      throw new ForbiddenException('Недостаточно прав для изменения ответственных');
    }

    const data: Prisma.OrderUpdateInput = {};

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

    if (dto.deliveryManagerId !== undefined) {
      const userId = await this.validateAssigneeRole(
        dto.deliveryManagerId,
        Role.MANAGER,
        'Менеджер ведения',
      );
      data.deliveryManager =
        userId === null ? { disconnect: true } : { connect: { id: userId } };
    }

    if (dto.onboardingManagerId !== undefined) {
      const userId = await this.validateAssigneeRole(
        dto.onboardingManagerId,
        Role.MANAGER,
        'Менеджер оформления',
      );
      data.onboardingManager =
        userId === null ? { disconnect: true } : { connect: { id: userId } };
    }

    if (dto.sketchDesignerId !== undefined) {
      const userId = await this.validateAssigneeRole(
        dto.sketchDesignerId,
        Role.DESIGNER,
        'Художник эскиза',
      );
      data.sketchDesigner =
        userId === null ? { disconnect: true } : { connect: { id: userId } };
    }

    if (dto.revisionDesignerId !== undefined) {
      const userId = await this.validateAssigneeRole(
        dto.revisionDesignerId,
        Role.DESIGNER,
        'Художник правок',
      );
      data.revisionDesigner =
        userId === null ? { disconnect: true } : { connect: { id: userId } };
    }

    const order = await this.prisma.order.update({
      where: { id },
      data,
      include: {
        deliveryManager: { select: this.userSelect },
        onboardingManager: { select: this.userSelect },
        sketchDesigner: { select: this.userSelect },
        revisionDesigner: { select: this.userSelect },
        bluesalesInfo: {
          select: {
            orderStatusId: true,
            orderStatus: true,
            crmStatusId: true,
            crmStatus: true,
          },
        },
      },
    });
    return this.withStats(order);
  }

  async getAssignees() {
    const users = await this.prisma.user.findMany({
      where: { role: { in: [Role.MANAGER, Role.DESIGNER] } },
      orderBy: [{ role: 'asc' }, { name: 'asc' }],
      select: this.userSelect,
    });
    return {
      managers: users.filter((user) => user.role === Role.MANAGER),
      designers: users.filter((user) => user.role === Role.DESIGNER),
    };
  }

  async getBluesalesStatuses() {
    const grouped = await this.prisma.bluesalesOrderInfo.groupBy({
      by: ['orderStatusId', 'orderStatus'],
      where: {
        orderStatusId: { not: null },
        orderStatus: { not: null },
      },
      orderBy: [{ orderStatus: 'asc' }],
    });

    return grouped
      .filter((s) => s.orderStatusId !== null && s.orderStatus !== null)
      .map((s) => ({
        id: s.orderStatusId as number,
        name: s.orderStatus as string,
      }));
  }

  async getCrmStatuses() {
    const grouped = await this.prisma.bluesalesOrderInfo.groupBy({
      by: ['crmStatusId', 'crmStatus'],
      where: {
        crmStatusId: { not: null },
        crmStatus: { not: null },
      },
      orderBy: [{ crmStatus: 'asc' }],
    });

    return grouped
      .filter((s) => s.crmStatusId !== null && s.crmStatus !== null)
      .map((s) => ({
        id: s.crmStatusId as number,
        name: s.crmStatus as string,
      }));
  }

  async updateBluesalesStatus(id: number, statusId: number) {
    const order = await this.prisma.order.findUnique({
      where: { id },
      select: {
        id: true,
        source: true,
        bluesalesInfo: {
          select: {
            bsOrderId: true,
          },
        },
      },
    });
    if (!order) {
      throw new NotFoundException('Заказ не найден');
    }
    if (!order.bluesalesInfo || order.source !== OrderSource.BLUESALES) {
      throw new BadRequestException('Для этого заказа недоступно изменение BS-статуса');
    }

    try {
      await this.bluesalesApi.setOrderStatus(order.bluesalesInfo.bsOrderId, statusId);
    } catch (err) {
      throw new BadGatewayException(
        `Не удалось обновить статус в BlueSales: ${(err as Error).message}`,
      );
    }

    let nextStatusId: number | null = statusId;
    let nextStatusName: string | null = null;
    try {
      const [actual] = await this.bluesalesApi.getOrdersByIds([order.bluesalesInfo.bsOrderId]);
      if (actual) {
        nextStatusId = actual.orderStatus?.id ?? statusId;
        nextStatusName = actual.orderStatus?.name ?? null;
      }
    } catch {
      // Некритично: даже если не смогли перечитать BS, сохраним хотя бы id.
    }

    await this.prisma.bluesalesOrderInfo.update({
      where: { orderId: id },
      data: {
        orderStatusId: nextStatusId,
        orderStatus: nextStatusName,
        lastSyncedAt: new Date(),
      },
    });

    return this.findOne(id);
  }

  async updateCrmStatus(id: number, crmStatusId: number | null, crmStatus: string | null) {
    const order = await this.prisma.order.findUnique({
      where: { id },
      select: {
        id: true,
        source: true,
        bluesalesInfo: {
          select: {
            orderId: true,
            crmStatusId: true,
            crmStatus: true,
          },
        },
      },
    });
    if (!order) {
      throw new NotFoundException('Заказ не найден');
    }
    if (!order.bluesalesInfo) {
      throw new BadRequestException(
        'Для этого заказа недоступно изменение CRM-статуса',
      );
    }

    let nextCrmStatusId = crmStatusId;
    let nextCrmStatus = crmStatus;
    if (nextCrmStatusId !== null && (!nextCrmStatus || !nextCrmStatus.trim())) {
      const known = await this.prisma.bluesalesOrderInfo.findFirst({
        where: {
          crmStatusId: nextCrmStatusId,
          crmStatus: { not: null },
        },
        select: { crmStatus: true },
      });
      nextCrmStatus = known?.crmStatus ?? `CRM #${nextCrmStatusId}`;
    }
    if (nextCrmStatusId === null) {
      nextCrmStatus = null;
    }

    await this.prisma.bluesalesOrderInfo.update({
      where: { orderId: id },
      data: {
        crmStatusId: nextCrmStatusId,
        crmStatus: nextCrmStatus,
        lastSyncedAt: new Date(),
      },
    });

    return this.findOne(id);
  }

  async getMetrics(id: number) {
    await this.findOne(id);
    return this.computeStats(id);
  }

  private async withStats(order: {
    id: number;
    orderNumber: string;
    title: string | null;
    source: OrderSource;
    createdAt: Date;
    deliveryManager?: {
      id: number;
      name: string;
      username: string;
      role: Role;
    } | null;
    onboardingManager?: {
      id: number;
      name: string;
      username: string;
      role: Role;
    } | null;
    sketchDesigner?: {
      id: number;
      name: string;
      username: string;
      role: Role;
    } | null;
    revisionDesigner?: {
      id: number;
      name: string;
      username: string;
      role: Role;
    } | null;
    bluesalesInfo?: {
      orderStatusId: number | null;
      orderStatus: string | null;
      crmStatusId: number | null;
      crmStatus: string | null;
    } | null;
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
      source: order.source,
      deliveryManager: order.deliveryManager ?? null,
      onboardingManager: order.onboardingManager ?? null,
      sketchDesigner: order.sketchDesigner ?? null,
      revisionDesigner: order.revisionDesigner ?? null,
      bsStatusId: order.bluesalesInfo?.orderStatusId ?? null,
      bsStatus: order.bluesalesInfo?.orderStatus ?? null,
      crmStatusId: order.bluesalesInfo?.crmStatusId ?? null,
      crmStatus: order.bluesalesInfo?.crmStatus ?? null,
      revisionCount: stats.revisionCount,
      openRevisions: stats.openRevisions,
      avgRevisionSeconds: stats.avgRevisionSeconds,
      lastMessageAt: last?.createdAt ?? null,
      createdAt: order.createdAt,
    };
  }

  private canChangeResponsible(actor: AuthUser) {
    if (actor.role === Role.ADMIN) {
      return true;
    }
    return actor.scopes.includes(UserScope.ORDERS_CHANGE_RESPONSIBLE);
  }

  private touchesResponsibleFields(dto: UpdateOrderDto) {
    return (
      dto.deliveryManagerId !== undefined ||
      dto.onboardingManagerId !== undefined ||
      dto.sketchDesignerId !== undefined ||
      dto.revisionDesignerId !== undefined
    );
  }

  private async validateAssigneeRole(
    userId: number | null,
    expectedRole: Role,
    label: string,
  ): Promise<number | null> {
    if (userId === null) {
      return null;
    }
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, role: true },
    });
    if (!user) {
      throw new BadRequestException(`${label}: пользователь не найден`);
    }
    if (user.role !== expectedRole) {
      throw new BadRequestException(
        `${label}: пользователь должен иметь роль ${expectedRole}`,
      );
    }
    return user.id;
  }

  private parseStatusIds(raw?: string): number[] {
    if (!raw) return [];
    const ids = raw
      .split(',')
      .map((part) => Number(part.trim()))
      .filter((value) => Number.isInteger(value) && value >= 0);
    return Array.from(new Set(ids));
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
