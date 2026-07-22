import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { OrderSource, Prisma, Role, UserScope } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { UpdateOrderDto } from './dto/update-order.dto';
import { AuthUser } from '../auth/current-user.decorator';
import { OrderEventChange, OrderEventsService } from './order-events.service';
import { computeSketchTimestampUpdate } from './sketch-status';

@Injectable()
export class OrdersService {
  constructor(
    private prisma: PrismaService,
    private orderEvents: OrderEventsService,
  ) {}

  private readonly userSelect = {
    id: true,
    name: true,
    username: true,
    role: true,
  } as const;

  /**
   * Пагинированная выборка заказов для ОДНОЙ колонки доски.
   * Колонка задаётся либо конкретным статусом заказа (`orderStatusId`), либо
   * флагом `noStatus` (заказы без статуса / без данных BlueSales). Поиск и
   * фильтры «по людям» применяются на сервере, чтобы пагинация была корректной.
   */
  async findAll(params: {
    orderStatusId?: number;
    noStatus?: boolean;
    q?: string;
    deliveryManagers?: string[];
    onboardingManagers?: string[];
    sketchDesigners?: string[];
    revisionDesigners?: string[];
    ignoreDesigners?: boolean;
    page?: number;
    limit?: number;
  }) {
    const and: Prisma.OrderWhereInput[] = [];

    if (params.noStatus) {
      // «Без статуса заказа»: либо у BlueSales-инфо пустой orderStatusId,
      // либо заказ вообще без BlueSales-инфо (ручной).
      and.push({
        OR: [
          { bluesalesInfo: { is: { orderStatusId: null } } },
          { bluesalesInfo: { is: null } },
        ],
      });
    } else if (
      params.orderStatusId !== undefined &&
      Number.isFinite(params.orderStatusId)
    ) {
      and.push({ bluesalesInfo: { is: { orderStatusId: params.orderStatusId } } });
    }

    const q = params.q?.trim();
    if (q) {
      and.push({
        OR: [
          { orderNumber: { contains: q, mode: 'insensitive' } },
          { title: { contains: q, mode: 'insensitive' } },
        ],
      });
    }

    if (params.deliveryManagers?.length) {
      and.push({ deliveryManagerName: { in: params.deliveryManagers } });
    }
    if (params.onboardingManagers?.length) {
      and.push({ onboardingManagerName: { in: params.onboardingManagers } });
    }
    // Для колонки «Готовим эскиз» фильтр по художникам может быть отключён
    // из настроек доски — тогда игнорируем оба фильтра художников.
    if (!params.ignoreDesigners) {
      if (params.sketchDesigners?.length) {
        and.push({ sketchDesigner: { is: { name: { in: params.sketchDesigners } } } });
      }
      if (params.revisionDesigners?.length) {
        and.push({ revisionDesigner: { is: { name: { in: params.revisionDesigners } } } });
      }
    }

    const where: Prisma.OrderWhereInput = and.length > 0 ? { AND: and } : {};

    const limit = Math.min(Math.max(Math.trunc(params.limit ?? 50) || 50, 1), 100);
    const page = Math.max(Math.trunc(params.page ?? 1) || 1, 1);
    const skip = (page - 1) * limit;

    const [total, orders] = await Promise.all([
      this.prisma.order.count({ where }),
      this.prisma.order.findMany({
        where,
        orderBy: [
          {
            bluesalesInfo: {
              bsCreatedAt: { sort: 'desc', nulls: 'last' },
            },
          },
          { id: 'desc' },
        ],
        skip,
        take: limit,
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
          statusChanges: {
            where: { state: { not: 'SUCCEEDED' } },
            orderBy: { id: 'asc' },
            take: 1,
            select: { state: true, attempts: true, lastError: true },
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
      page,
      limit,
      hasMore: skip + orders.length < total,
    };
  }

  /**
   * Уникальные имена менеджеров ведения/оформления — для фильтров доски
   * (клиент больше не держит все заказы у себя, поэтому опции берём с сервера).
   */
  async getManagerOptions() {
    const [delivery, onboarding] = await Promise.all([
      this.prisma.order.findMany({
        where: { deliveryManagerName: { not: null } },
        distinct: ['deliveryManagerName'],
        select: { deliveryManagerName: true },
        orderBy: { deliveryManagerName: 'asc' },
      }),
      this.prisma.order.findMany({
        where: { onboardingManagerName: { not: null } },
        distinct: ['onboardingManagerName'],
        select: { onboardingManagerName: true },
        orderBy: { onboardingManagerName: 'asc' },
      }),
    ]);
    return {
      deliveryManagers: delivery
        .map((o) => o.deliveryManagerName)
        .filter((n): n is string => !!n),
      onboardingManagers: onboarding
        .map((o) => o.onboardingManagerName)
        .filter((n): n is string => !!n),
    };
  }

  async getOrderStatusSync(ids: number[]) {
    const normalized = Array.from(
      new Set(ids.filter((id) => Number.isInteger(id) && id > 0)),
    ).slice(0, 200);
    if (normalized.length === 0) return [];

    const orders = await this.prisma.order.findMany({
      where: { id: { in: normalized } },
      select: {
        id: true,
        statusChanges: {
          where: { state: { not: 'SUCCEEDED' } },
          orderBy: { id: 'asc' },
          take: 1,
          select: { state: true, attempts: true, lastError: true },
        },
      },
    });
    return orders.map((order) => ({
      orderId: order.id,
      orderStatusSync: this.serializeOrderStatusSync(order.statusChanges[0] ?? null),
    }));
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
            tags: {
              select: {
                bsTagId: true,
                name: true,
                color: true,
              },
              orderBy: { name: 'asc' },
            },
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
        statusChanges: {
          where: { state: { not: 'SUCCEEDED' } },
          orderBy: { id: 'asc' },
          take: 1,
          select: { state: true, attempts: true, lastError: true },
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
      lead: order.lead
        ? {
            ...order.lead,
            tags: order.lead.tags.map((tag) => ({
              id: tag.bsTagId,
              name: tag.name,
              color: tag.color,
            })),
          }
        : null,
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
    const existing = await this.prisma.order.findUnique({
      where: { id },
      include: {
        sketchDesigner: { select: { id: true, name: true } },
        revisionDesigner: { select: { id: true, name: true } },
      },
    });
    if (!existing) {
      throw new NotFoundException('Заказ не найден');
    }

    const touchesResponsible = this.touchesResponsibleFields(dto);
    if (touchesResponsible && !this.canChangeResponsible(actor)) {
      throw new ForbiddenException('Недостаточно прав для изменения ответственных');
    }

    const data: Prisma.OrderUpdateInput = {};
    const changes: OrderEventChange[] = [];

    if (dto.orderNumber !== undefined) {
      const orderNumber = dto.orderNumber.trim();
      if (orderNumber !== existing.orderNumber) {
        const conflict = await this.prisma.order.findUnique({
          where: { orderNumber },
        });
        if (conflict) {
          throw new ConflictException('Заказ с таким номером уже существует');
        }
        changes.push({
          field: 'orderNumber',
          oldValue: existing.orderNumber,
          newValue: orderNumber,
        });
      }
      data.orderNumber = orderNumber;
    }

    if (dto.title !== undefined) {
      const title = dto.title.trim();
      const nextTitle = title.length > 0 ? title : null;
      if (nextTitle !== existing.title) {
        changes.push({ field: 'title', oldValue: existing.title, newValue: nextTitle });
      }
      data.title = nextTitle;
    }

    if (dto.note !== undefined) {
      const note = (dto.note ?? '').trim();
      const nextNote = note.length > 0 ? note : null;
      if (nextNote !== existing.note) {
        changes.push({ field: 'note', oldValue: existing.note, newValue: nextNote });
      }
      data.note = nextNote;
    }

    if (dto.dialogLink !== undefined) {
      const dialogLink = (dto.dialogLink ?? '').trim();
      const nextDialogLink = dialogLink.length > 0 ? dialogLink : null;
      if (nextDialogLink !== existing.dialogLink) {
        changes.push({
          field: 'dialogLink',
          oldValue: existing.dialogLink,
          newValue: nextDialogLink,
        });
      }
      data.dialogLink = nextDialogLink;
    }

    if (dto.sketchDesignerId !== undefined) {
      const next = await this.validateAssigneeRole(
        dto.sketchDesignerId,
        Role.SKETCH_DESIGNER,
        'Художник эскиза',
      );
      const nextId = next?.id ?? null;
      if (nextId !== existing.sketchDesignerId) {
        changes.push({
          field: 'sketchDesigner',
          oldValue: existing.sketchDesigner?.name ?? null,
          newValue: next?.name ?? null,
          meta: { oldId: existing.sketchDesignerId, newId: nextId },
        });
      }
      data.sketchDesigner =
        nextId === null ? { disconnect: true } : { connect: { id: nextId } };
    }

    if (dto.revisionDesignerId !== undefined) {
      const next = await this.validateAssigneeRole(
        dto.revisionDesignerId,
        Role.REVISION_DESIGNER,
        'Художник правок',
      );
      const nextId = next?.id ?? null;
      if (nextId !== existing.revisionDesignerId) {
        changes.push({
          field: 'revisionDesigner',
          oldValue: existing.revisionDesigner?.name ?? null,
          newValue: next?.name ?? null,
          meta: { oldId: existing.revisionDesignerId, newId: nextId },
        });
      }
      data.revisionDesigner =
        nextId === null ? { disconnect: true } : { connect: { id: nextId } };
    }

    await this.prisma.order.update({
      where: { id },
      data,
    });
    await this.orderEvents.record(id, actor.id, changes);
    return this.findOne(id);
  }

  async getAssignees() {
    const users = await this.prisma.user.findMany({
      where: {
        role: {
          in: [Role.MANAGER, Role.SKETCH_DESIGNER, Role.REVISION_DESIGNER],
        },
      },
      orderBy: [{ role: 'asc' }, { name: 'asc' }],
      select: this.userSelect,
    });
    return {
      managers: users.filter((user) => user.role === Role.MANAGER),
      sketchDesigners: users.filter((user) => user.role === Role.SKETCH_DESIGNER),
      revisionDesigners: users.filter(
        (user) => user.role === Role.REVISION_DESIGNER,
      ),
    };
  }

  async getOrderStatuses() {
    // Текущие статусы, реально встречающиеся среди синхронизированных заказов.
    const grouped = await this.prisma.bluesalesOrderInfo.groupBy({
      by: ['orderStatusId', 'orderStatus'],
      where: {
        orderStatusId: { not: null },
        orderStatus: { not: null },
      },
      orderBy: [{ orderStatus: 'asc' }],
    });

    const fromOrders = grouped
      .filter((s) => s.orderStatusId !== null && s.orderStatus !== null)
      .map((s) => ({
        id: s.orderStatusId as number,
        name: s.orderStatus as string,
      }));

    // Актуализируем накопительный справочник: если постгрес вернул статус,
    // которого ещё нет в справочнике (или у него изменилось имя) — фиксируем его.
    // Благодаря этому статус остаётся в списке даже когда в нём сейчас 0 заказов.
    if (fromOrders.length > 0) {
      await this.prisma.$transaction(
        fromOrders.map((s) =>
          this.prisma.bluesalesOrderStatus.upsert({
            where: { bsOrderStatusId: s.id },
            create: { bsOrderStatusId: s.id, name: s.name },
            update: { name: s.name },
          }),
        ),
      );
    }

    // Возвращаем объединение: полный справочник (он уже включает всё, что вернул
    // постгрес, плюс ранее накопленные статусы без активных заказов).
    const dictionary = await this.prisma.bluesalesOrderStatus.findMany({
      orderBy: [{ name: 'asc' }],
    });

    return dictionary.map((s) => ({ id: s.bsOrderStatusId, name: s.name }));
  }

  async getTags() {
    const tags = await this.prisma.bluesalesTag.findMany({
      orderBy: [{ name: 'asc' }],
      select: {
        bsTagId: true,
        name: true,
        color: true,
      },
    });

    return tags.map((tag) => ({
      id: tag.bsTagId,
      name: tag.name,
      color: tag.color,
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

  async updateOrderStatus(id: number, statusId: number, actor?: AuthUser) {
    const [order, targetStatus] = await Promise.all([
      this.prisma.order.findUnique({
        where: { id },
        select: {
          id: true,
          source: true,
          bluesalesInfo: { select: { orderId: true } },
        },
      }),
      this.prisma.bluesalesOrderStatus.findUnique({
        where: { bsOrderStatusId: statusId },
        select: { name: true },
      }),
    ]);

    if (!order) {
      throw new NotFoundException('Заказ не найден');
    }
    if (!order.bluesalesInfo || order.source !== OrderSource.BLUESALES) {
      throw new BadRequestException('Для этого заказа недоступно изменение статуса заказа');
    }
    if (!targetStatus) {
      throw new BadRequestException('Неизвестный статус заказа BlueSales');
    }

    await this.prisma.$transaction(async (tx) => {
      // Сериализуем быстрые изменения одного заказа, чтобы delta всегда содержала
      // фактический предыдущий локальный статус.
      await tx.$queryRaw`
        SELECT "orderId"
        FROM "BluesalesOrderInfo"
        WHERE "orderId" = ${id}
        FOR UPDATE
      `;

      const current = await tx.order.findUnique({
        where: { id },
        select: {
          sketchStartedAt: true,
          sketchReadyAt: true,
          bluesalesInfo: {
            select: { orderStatusId: true, orderStatus: true },
          },
        },
      });
      if (!current?.bluesalesInfo) {
        throw new BadRequestException('Для этого заказа недоступно изменение статуса заказа');
      }

      const prevStatusId = current.bluesalesInfo.orderStatusId;
      const prevStatusName = current.bluesalesInfo.orderStatus;
      if (prevStatusId === statusId) return;

      const sketchUpdate = computeSketchTimestampUpdate(targetStatus.name, current);
      const eventData = this.orderEvents.buildCreateManyData(id, actor?.id ?? null, [
        {
          field: 'orderStatus',
          oldValue: prevStatusName,
          newValue: targetStatus.name,
          meta: { oldId: prevStatusId, newId: statusId },
        },
      ]);

      await tx.bluesalesOrderInfo.update({
        where: { orderId: id },
        data: {
          orderStatusId: statusId,
          orderStatus: targetStatus.name,
        },
      });
      // Даже если метки не меняются, update поднимает Order.updatedAt и карточку
      // с новым статусом наверх доски.
      await tx.order.update({
        where: { id },
        data: { ...sketchUpdate, updatedAt: new Date() },
      });
      await tx.orderStatusChange.create({
        data: {
          orderId: id,
          actorId: actor?.id ?? null,
          fromStatusId: prevStatusId,
          fromStatusName: prevStatusName,
          toStatusId: statusId,
          toStatusName: targetStatus.name,
        },
      });
      if (eventData.length > 0) {
        await tx.orderEvent.createMany({ data: eventData });
      }
    });

    return this.findOne(id);
  }

  async updateCrmStatus(
    id: number,
    crmStatusId: number | null,
    crmStatus: string | null,
    actor?: AuthUser,
  ) {
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

    const prevCrmStatusId = order.bluesalesInfo.crmStatusId;
    const prevCrmStatus = order.bluesalesInfo.crmStatus;

    await this.prisma.bluesalesOrderInfo.update({
      where: { orderId: id },
      data: {
        crmStatusId: nextCrmStatusId,
        crmStatus: nextCrmStatus,
        lastSyncedAt: new Date(),
      },
    });

    if (nextCrmStatusId !== prevCrmStatusId) {
      await this.orderEvents.record(id, actor?.id ?? null, [
        {
          field: 'crmStatus',
          oldValue: prevCrmStatus,
          newValue: nextCrmStatus,
          meta: { oldId: prevCrmStatusId, newId: nextCrmStatusId },
        },
      ]);
    }

    return this.findOne(id);
  }

  async getMetrics(id: number) {
    await this.findOne(id);
    return this.computeStats(id);
  }

  async getEvents(id: number) {
    const order = await this.prisma.order.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!order) {
      throw new NotFoundException('Заказ не найден');
    }
    return this.orderEvents.list(id);
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
      orderStatusSync: this.serializeOrderStatusSync(order.statusChanges?.[0] ?? null),
      crmStatusId: order.bluesalesInfo?.crmStatusId ?? null,
      crmStatus: order.bluesalesInfo?.crmStatus ?? null,
      revisionCount: stats.revisionCount,
      openRevisions: stats.openRevisions,
      avgRevisionSeconds: stats.avgRevisionSeconds,
      lastMessageAt,
      note: order.note ?? null,
      createdAt: order.createdAt,
    };
  }

  private serializeOrderStatusSync(
    change:
      | {
          state: 'PENDING' | 'PROCESSING' | 'RETRY' | 'SUCCEEDED';
          attempts: number;
          lastError: string | null;
        }
      | null,
  ) {
    return change
      ? {
          state: change.state === 'RETRY' ? ('retrying' as const) : ('pending' as const),
          attempts: change.attempts,
          lastError: change.lastError,
        }
      : null;
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
  ): Promise<{ id: number; name: string } | null> {
    if (userId === null) {
      return null;
    }
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, name: true, role: true },
    });
    if (!user) {
      throw new BadRequestException(`${label}: пользователь не найден`);
    }
    if (user.role !== expectedRole) {
      throw new BadRequestException(
        `${label}: пользователь должен иметь роль ${expectedRole}`,
      );
    }
    return { id: user.id, name: user.name };
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
  note: string | null;
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
  statusChanges?: Array<{
    state: 'PENDING' | 'PROCESSING' | 'RETRY' | 'SUCCEEDED';
    attempts: number;
    lastError: string | null;
  }>;
};
