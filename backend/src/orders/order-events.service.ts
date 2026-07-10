import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Одно изменение поля заказа для записи в лог.
 * `oldValue`/`newValue` — уже человекочитаемые строки (имена/статусы/текст).
 */
export interface OrderEventChange {
  field: string;
  oldValue: string | null;
  newValue: string | null;
  meta?: Prisma.InputJsonValue;
}

const actorSelect = { id: true, name: true, role: true } as const;

const eventInclude = {
  actor: { select: actorSelect },
} satisfies Prisma.OrderEventInclude;

type OrderEventWithActor = Prisma.OrderEventGetPayload<{ include: typeof eventInclude }>;

@Injectable()
export class OrderEventsService {
  private readonly logger = new Logger(OrderEventsService.name);

  constructor(private prisma: PrismaService) {}

  /**
   * Пишет пачку событий об изменениях полей заказа. Записи, где значение не
   * изменилось, отбрасываются. Ошибка записи лога не должна ронять основную
   * операцию, поэтому она проглатывается с логированием.
   */
  async record(
    orderId: number,
    actorId: number | null,
    changes: OrderEventChange[],
  ): Promise<void> {
    const meaningful = changes.filter((c) => c.oldValue !== c.newValue);
    if (meaningful.length === 0) return;
    try {
      await this.prisma.orderEvent.createMany({
        data: meaningful.map((c) => ({
          orderId,
          actorId,
          field: c.field,
          oldValue: c.oldValue,
          newValue: c.newValue,
          meta: c.meta ?? Prisma.JsonNull,
        })),
      });
    } catch (err) {
      this.logger.error(
        `Не удалось записать события заказа #${orderId}: ${(err as Error).message}`,
      );
    }
  }

  async list(orderId: number) {
    const rows = await this.prisma.orderEvent.findMany({
      where: { orderId },
      orderBy: { id: 'asc' },
      include: eventInclude,
    });
    return rows.map((e) => this.serialize(e));
  }

  private serialize(e: OrderEventWithActor) {
    return {
      id: e.id,
      orderId: e.orderId,
      field: e.field,
      oldValue: e.oldValue,
      newValue: e.newValue,
      actor: e.actor,
      createdAt: e.createdAt,
    };
  }
}
