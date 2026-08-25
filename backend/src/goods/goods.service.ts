import { Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import { OrderDirection } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { extractGoodsPositions, GoodsPosition } from './goods-payload';

/** Сколько заказов читаем за один шаг разового бэкфилла справочника. */
const BACKFILL_BATCH = 200;

/**
 * Время жизни кэша известных товаров, мс. Refresh-loop синка перечитывает одни
 * и те же заказы по кругу, поэтому уже известные товары не переписываем;
 * переименования в BlueSales подхватываются на следующем истечении кэша.
 */
const KNOWN_CACHE_TTL = 10 * 60 * 1000;

@Injectable()
export class GoodsService implements OnModuleInit {
  private readonly logger = new Logger(GoodsService.name);
  private knownCache: { ids: Set<number>; expiresAt: number } | null = null;
  private knownLoad: Promise<Set<number>> | null = null;

  constructor(private prisma: PrismaService) {}

  async onModuleInit() {
    // Справочник наполняется при синке заказов, но у уже накопленных заказов
    // товары остались только в rawPayload — разово добираем их при старте.
    void this.backfillFromOrders().catch((err) => {
      this.logger.error(`Не удалось добрать справочник товаров: ${(err as Error).message}`);
    });
  }

  async list() {
    const goods = await this.prisma.bluesalesGoods.findMany({
      orderBy: [{ name: 'asc' }],
    });
    return goods.map((item) => ({
      id: item.bsGoodsId,
      name: item.name,
      marking: item.marking,
      direction: item.direction,
    }));
  }

  async updateDirection(bsGoodsId: number, direction: OrderDirection | null) {
    const existing = await this.prisma.bluesalesGoods.findUnique({
      where: { bsGoodsId },
    });
    if (!existing) {
      throw new NotFoundException('Товар не найден');
    }
    const updated = await this.prisma.bluesalesGoods.update({
      where: { bsGoodsId },
      data: { direction },
    });
    return {
      id: updated.bsGoodsId,
      name: updated.name,
      marking: updated.marking,
      direction: updated.direction,
    };
  }

  /**
   * Пополняет справочник товарами из «сырого» заказа BlueSales.
   * `direction` задаёт администратор, поэтому при повторной встрече товара
   * обновляем только название и артикул.
   */
  async upsertFromPayload(rawPayload: unknown) {
    await this.upsertPositions(extractGoodsPositions(rawPayload));
  }

  /** Направления товаров, влияющих на тип заказа: id товара -> направление. */
  async getDirectionMap(): Promise<Map<number, OrderDirection>> {
    const rows = await this.prisma.bluesalesGoods.findMany({
      where: { direction: { not: null } },
      select: { bsGoodsId: true, direction: true },
    });
    return new Map(
      rows.map((row) => [row.bsGoodsId, row.direction as OrderDirection]),
    );
  }

  private async upsertPositions(positions: GoodsPosition[]) {
    if (positions.length === 0) return;
    const known = await this.getKnownIds();
    for (const position of positions) {
      if (known.has(position.bsGoodsId)) continue;
      await this.prisma.bluesalesGoods.upsert({
        where: { bsGoodsId: position.bsGoodsId },
        create: {
          bsGoodsId: position.bsGoodsId,
          name: position.name,
          marking: position.marking,
        },
        update: { name: position.name, marking: position.marking },
      });
      known.add(position.bsGoodsId);
    }
  }

  private async getKnownIds(): Promise<Set<number>> {
    const cached = this.knownCache;
    if (cached && cached.expiresAt > Date.now()) return cached.ids;

    if (!this.knownLoad) {
      this.knownLoad = this.prisma.bluesalesGoods
        .findMany({ select: { bsGoodsId: true } })
        .then((rows) => {
          const ids = new Set(rows.map((row) => row.bsGoodsId));
          this.knownCache = { ids, expiresAt: Date.now() + KNOWN_CACHE_TTL };
          return ids;
        })
        .finally(() => {
          this.knownLoad = null;
        });
    }
    return this.knownLoad;
  }

  private async backfillFromOrders() {
    const known = await this.prisma.bluesalesGoods.count();
    if (known > 0) return;

    let cursor: number | undefined;
    let scanned = 0;
    for (;;) {
      const batch = await this.prisma.bluesalesOrderInfo.findMany({
        take: BACKFILL_BATCH,
        ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
        orderBy: { id: 'asc' },
        select: { id: true, rawPayload: true },
      });
      if (batch.length === 0) break;

      for (const info of batch) {
        await this.upsertPositions(extractGoodsPositions(info.rawPayload));
      }
      scanned += batch.length;
      cursor = batch[batch.length - 1].id;
    }

    if (scanned > 0) {
      const total = await this.prisma.bluesalesGoods.count();
      this.logger.log(
        `Справочник товаров добран из ${scanned} заказов: ${total} позиций`,
      );
    }
  }
}
