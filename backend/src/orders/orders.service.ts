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
    orderStatusId?: number,
    orderStatusIdsRaw?: string,
    crmStatusIdsRaw?: string,
    q?: string,
    page = 1,
    limit = 30,
  ) {
    const where: Prisma.OrderWhereInput = {};
    const orderStatusIds = this.parseStatusIds(orderStatusIdsRaw);
    if (orderStatusId !== undefined && Number.isFinite(orderStatusId)) {
      orderStatusIds.push(orderStatusId);
    }
    const normalizedOrderStatusIds = Array.from(new Set(orderStatusIds));
    const shouldReturnAllForStatuses = normalizedOrderStatusIds.length > 0;

    const bluesalesInfoFilter: Prisma.BluesalesOrderInfoWhereInput = {};
    if (normalizedOrderStatusIds.length > 0) {
      bluesalesInfoFilter.orderStatusId = { in: normalizedOrderStatusIds };
    }
    const crmStatusIds = this.parseStatusIds(crmStatusIdsRaw);
    if (crmStatusIds.length > 0) {
      bluesalesInfoFilter.crmStatusId = { in: crmStatusIds };
    }
    if (shouldReturnAllForStatuses) {
      const threeMonthsAgo = new Date();
      threeMonthsAgo.setMonth(threeMonthsAgo.getMonth() - 3);
      bluesalesInfoFilter.bsCreatedAt = { gte: threeMonthsAgo };
    }
    if (Object.keys(bluesalesInfoFilter).length > 0) {
      where.bluesalesInfo = { is: bluesalesInfoFilter };
    }
    if (q && q.trim()) {
      where.OR = [
        { orderNumber: { contains: q, mode: 'insensitive' } },
        { title: { contains: q, mode: 'insensitive' } },
      ];
    }

    const safeLimit = shouldReturnAllForStatuses
      ? null
      : Math.min(Math.max(Math.trunc(limit) || 30, 1), 100);
    const safePage = shouldReturnAllForStatuses ? 1 : Math.max(Math.trunc(page) || 1, 1);

    const [total, orders] = await Promise.all([
      this.prisma.order.count({ where }),
      this.prisma.order.findMany({
        where,
        orderBy: { updatedAt: 'desc' },
        ...(safeLimit
          ? {
              skip: (safePage - 1) * safeLimit,
              take: safeLimit,
            }
          : {}),
        include: {
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

    const orderIds = orders.map((o) => o.id);
    const [statsById, lastMessageById] = await Promise.all([
      this.computeStatsBatch(orderIds),
      this.lastMessagesBatch(orderIds),
    ]);
    const items = orders.map((o) =>
      this.buildOrderView(
        o,
        statsById.get(o.id) ?? { revisionCount: 0, openRevisions: 0, avgRevisionSeconds: null },
        lastMessageById.get(o.id) ?? null,
      ),
    );

    return {
      items,
      total,
      page: safePage,
      limit: safeLimit ?? total,
      totalPages: safeLimit ? Math.max(Math.ceil(total / safeLimit), 1) : 1,
    };
  }

  async findOne(id: number) {
    const order = await this.prisma.order.findUnique({
      where: { id },
      include: {
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
            rawPayload: true,
          },
        },
      },
    });
    if (!order) {
      throw new NotFoundException('Заказ не найден');
    }
    const base = await this.withStats(order);
    const articles = this.extractArticles(order.bluesalesInfo?.rawPayload);
    // rawPayload — тяжёлый JSON целого заказа BlueSales; наружу не отдаём,
    // из него отдаём только извлечённый список артикулов.
    const { rawPayload: _rawPayload, ...bluesalesInfo } = order.bluesalesInfo ?? {};
    return {
      ...base,
      source: order.source,
      dialogLink: order.dialogLink,
      deliveryManagerName: order.deliveryManagerName,
      onboardingManagerName: order.onboardingManagerName,
      sketchDesigner: order.sketchDesigner,
      revisionDesigner: order.revisionDesigner,
      lead: order.lead,
      bluesalesInfo: order.bluesalesInfo ? bluesalesInfo : null,
      articles,
    };
  }

  /**
   * Достаёт список позиций заказа (артикул + название + количество) из
   * сырого ответа BlueSales (`rawPayload`). Структура ответа BlueSales
   * формально не типизирована, а названия полей варьируются, поэтому
   * позиции и их атрибуты ищем перебором вероятных ключей (как это уже
   * сделано для дат/сумм/источников в bluesales-sync.service).
   */
  private extractArticles(rawPayload: Prisma.JsonValue | null | undefined): Array<{
    article: string | null;
    name: string | null;
    quantity: number | null;
  }> {
    if (!rawPayload || typeof rawPayload !== 'object' || Array.isArray(rawPayload)) {
      return [];
    }
    const order = rawPayload as Record<string, unknown>;

    const positionsKeys = [
      'goodsPositions',
      'orderProducts',
      'products',
      'orderItems',
      'items',
      'positions',
      'goods',
      'lines',
      'productList',
      'orderProductList',
    ];
    let positions: unknown[] = [];
    for (const key of positionsKeys) {
      const value = order[key];
      if (Array.isArray(value) && value.length > 0) {
        positions = value;
        break;
      }
    }
    if (positions.length === 0) {
      return [];
    }

    const result: Array<{ article: string | null; name: string | null; quantity: number | null }> =
      [];
    for (const raw of positions) {
      if (!raw || typeof raw !== 'object') continue;
      const pos = raw as Record<string, unknown>;
      const product =
        pos.product && typeof pos.product === 'object'
          ? (pos.product as Record<string, unknown>)
          : {};
      const nomenclature =
        pos.nomenclature && typeof pos.nomenclature === 'object'
          ? (pos.nomenclature as Record<string, unknown>)
          : {};
      // В ответе BlueSales позиция товара называется `goods`, а артикул лежит
      // в поле `marking` (см. order_raw_payload.json).
      const goods =
        pos.goods && typeof pos.goods === 'object'
          ? (pos.goods as Record<string, unknown>)
          : {};

      const article = this.pickString(
        pos.marking,
        pos.article,
        pos.articul,
        pos.vendorCode,
        pos.sku,
        pos.code,
        pos.productArticle,
        pos.productCode,
        goods.marking,
        goods.article,
        goods.articul,
        goods.vendorCode,
        goods.sku,
        goods.code,
        product.article,
        product.articul,
        product.vendorCode,
        product.sku,
        product.code,
        nomenclature.article,
        nomenclature.articul,
        nomenclature.vendorCode,
        nomenclature.code,
      );
      const name = this.pickString(
        pos.name,
        pos.productName,
        pos.title,
        goods.name,
        goods.title,
        product.name,
        product.title,
        nomenclature.name,
      );
      const quantity = this.pickNumber(pos.count, pos.quantity, pos.amount, pos.qty, pos.number);

      if (article === null && name === null) continue;
      result.push({ article, name, quantity });
    }
    return result;
  }

  private pickString(...values: unknown[]): string | null {
    for (const value of values) {
      if (typeof value === 'string') {
        const trimmed = value.trim();
        if (trimmed.length > 0) return trimmed;
      } else if (typeof value === 'number' && Number.isFinite(value)) {
        return String(value);
      }
    }
    return null;
  }

  private pickNumber(...values: unknown[]): number | null {
    for (const value of values) {
      if (typeof value === 'number' && Number.isFinite(value)) return value;
      if (typeof value === 'string') {
        const normalized = value.trim().replace(',', '.');
        if (!normalized) continue;
        const parsed = Number(normalized);
        if (Number.isFinite(parsed)) return parsed;
      }
    }
    return null;
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

    if (dto.dialogLink !== undefined) {
      const dialogLink = (dto.dialogLink ?? '').trim();
      data.dialogLink = dialogLink.length > 0 ? dialogLink : null;
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

    await this.prisma.order.update({
      where: { id },
      data,
    });
    return this.findOne(id);
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

  async getOrderStatuses() {
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

  async updateOrderStatus(id: number, statusId: number) {
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
      throw new BadRequestException('Для этого заказа недоступно изменение статуса заказа');
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
      const [actual] = await this.bluesalesApi.getOrdersByIds(
        [order.bluesalesInfo.bsOrderId],
        'interactive',
      );
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

  private async withStats(order: OrderForView) {
    const stats = await this.computeStats(order.id);
    const last = await this.prisma.message.findFirst({
      where: { orderId: order.id },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true },
    });
    return this.buildOrderView(order, stats, last?.createdAt ?? null);
  }

  private buildOrderView(
    order: OrderForView,
    stats: OrderStats,
    lastMessageAt: Date | null,
  ) {
    return {
      id: order.id,
      orderNumber: order.orderNumber,
      title: order.title,
      source: order.source,
      dialogLink: order.dialogLink ?? null,
      deliveryManagerName: order.deliveryManagerName ?? null,
      onboardingManagerName: order.onboardingManagerName ?? null,
      sketchDesigner: order.sketchDesigner ?? null,
      revisionDesigner: order.revisionDesigner ?? null,
      orderStatusId: order.bluesalesInfo?.orderStatusId ?? null,
      orderStatus: order.bluesalesInfo?.orderStatus ?? null,
      crmStatusId: order.bluesalesInfo?.crmStatusId ?? null,
      crmStatus: order.bluesalesInfo?.crmStatus ?? null,
      revisionCount: stats.revisionCount,
      openRevisions: stats.openRevisions,
      avgRevisionSeconds: stats.avgRevisionSeconds,
      lastMessageAt,
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

  private async computeStats(orderId: number): Promise<OrderStats> {
    const revisionCount = await this.prisma.revision.count({
      where: { orderId },
    });
    const openRevisions = await this.prisma.revision.count({
      where: { orderId, closure: { is: null } },
    });

    // Среднее время правки: для каждой закрытой правки — время между openedAt и closedAt.
    const closures = await this.prisma.revisionClosure.findMany({
      where: { revision: { orderId } },
      select: { openedAt: true, closedAt: true },
    });
    const durations = closures
      .map((c) => (c.closedAt.getTime() - c.openedAt.getTime()) / 1000)
      .filter((s) => s >= 0);
    const avgRevisionSeconds =
      durations.length > 0
        ? Math.round(durations.reduce((sum, s) => sum + s, 0) / durations.length)
        : null;

    return { revisionCount, openRevisions, avgRevisionSeconds };
  }

  /**
   * Считает статистику правок сразу для набора заказов (для списка).
   * Вместо N+1 (по 3 запроса на каждый заказ) — 3 запроса на всю страницу:
   * общее число правок, число открытых и среднее время закрытия.
   */
  private async computeStatsBatch(orderIds: number[]): Promise<Map<number, OrderStats>> {
    const result = new Map<number, OrderStats>();
    if (orderIds.length === 0) {
      return result;
    }

    const [totals, open, closures] = await Promise.all([
      this.prisma.revision.groupBy({
        by: ['orderId'],
        where: { orderId: { in: orderIds } },
        _count: { _all: true },
      }),
      this.prisma.revision.groupBy({
        by: ['orderId'],
        where: { orderId: { in: orderIds }, closure: { is: null } },
        _count: { _all: true },
      }),
      this.prisma.revisionClosure.findMany({
        where: { revision: { orderId: { in: orderIds } } },
        select: {
          openedAt: true,
          closedAt: true,
          revision: { select: { orderId: true } },
        },
      }),
    ]);

    const totalById = new Map(totals.map((t) => [t.orderId, t._count._all]));
    const openById = new Map(open.map((t) => [t.orderId, t._count._all]));

    const durSum = new Map<number, number>();
    const durCount = new Map<number, number>();
    for (const c of closures) {
      const orderId = c.revision.orderId;
      const seconds = (c.closedAt.getTime() - c.openedAt.getTime()) / 1000;
      if (seconds < 0) continue;
      durSum.set(orderId, (durSum.get(orderId) ?? 0) + seconds);
      durCount.set(orderId, (durCount.get(orderId) ?? 0) + 1);
    }

    for (const orderId of orderIds) {
      const count = durCount.get(orderId) ?? 0;
      const avgRevisionSeconds =
        count > 0 ? Math.round((durSum.get(orderId) ?? 0) / count) : null;
      result.set(orderId, {
        revisionCount: totalById.get(orderId) ?? 0,
        openRevisions: openById.get(orderId) ?? 0,
        avgRevisionSeconds,
      });
    }
    return result;
  }

  /**
   * Время последнего сообщения для набора заказов — одним groupBy вместо
   * findFirst на каждый заказ.
   */
  private async lastMessagesBatch(orderIds: number[]): Promise<Map<number, Date>> {
    const result = new Map<number, Date>();
    if (orderIds.length === 0) {
      return result;
    }
    const grouped = await this.prisma.message.groupBy({
      by: ['orderId'],
      where: { orderId: { in: orderIds } },
      _max: { createdAt: true },
    });
    for (const g of grouped) {
      if (g._max.createdAt) {
        result.set(g.orderId, g._max.createdAt);
      }
    }
    return result;
  }
}

type OrderStats = {
  revisionCount: number;
  openRevisions: number;
  avgRevisionSeconds: number | null;
};

type OrderForView = {
  id: number;
  orderNumber: string;
  title: string | null;
  source: OrderSource;
  createdAt: Date;
  dialogLink?: string | null;
  deliveryManagerName?: string | null;
  onboardingManagerName?: string | null;
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
};
