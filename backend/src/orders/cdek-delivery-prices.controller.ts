import {
  BadRequestException, Body, ConflictException, Controller, Get, NotFoundException,
  Param, ParseIntPipe, Put, Query, UseGuards,
} from '@nestjs/common';
import { Prisma, Role } from '@prisma/client';
import { IsBoolean, IsInt, IsOptional, IsString, Matches, Max, Min, ValidateIf } from 'class-validator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { BluesalesApiService } from '../bluesales/bluesales-api.service';
import { PrismaService } from '../prisma/prisma.service';
import { deliveryField, differenceText } from './cdek-delivery-field';

const FIELD_ID = 7358;
const PAGE_SIZE = 25;
// Metallity order statuses: handed to the recipient, canceled, return.
const closedStatuses = [145342, 145343, 174993];
const calculatedValue = /^(?:✓|🔴) Разница (?:0,00|[+-](?:0|[1-9]\d*),\d{2}) ₽$/u;

class PriceUpdate {
  @IsInt() @Min(1) @Max(2147483647) bsOrderId!: number;
  @IsString() @Matches(/^\d{1,40}$/) tracking!: string;
  @IsInt() @Min(0) @Max(Number.MAX_SAFE_INTEGER) quotedKopecks!: number;
  @IsInt() @Min(0) @Max(Number.MAX_SAFE_INTEGER) carrierKopecks!: number;
  @ValidateIf((_object, value) => value !== null) @IsString() previousValue!: string | null;
  @IsOptional() @IsBoolean() existingBeforeArrival?: boolean;
  @IsOptional() @IsBoolean() existingBeforeHandover?: boolean;
}

function activation(): Date {
  const text = process.env.CDEK_DELIVERY_PRICE_FROM_UTC;
  if (!text) throw new NotFoundException('Сверка доставки выключена');
  const date = new Date(text);
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(text) ||
      !Number.isFinite(date.getTime()) || date.toISOString().replace('.000Z', 'Z') !== text) {
    throw new ConflictException('Некорректная дата начала сверки');
  }
  if (date.getTime() > Date.now()) throw new NotFoundException('Время начала сверки ещё не наступило');
  return date;
}

function cursor(value: string | undefined): number {
  if (value === undefined) return 0;
  if (!/^\d{1,10}$/.test(value) || Number(value) > 2147483647) throw new BadRequestException('Некорректный курсор');
  return Number(value);
}

function asObject(value: Prisma.JsonValue | undefined) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : undefined;
}

// null means an empty/comment-only field; undefined means its numbers are ambiguous.
function fieldTrack(value: string, orderNumber: string): string | null | undefined {
  const text = value.trim();
  if (/^\d{1,40}$/.test(text)) return text;
  const pair = /^(\d{1,40})\s*\/\s*(\d{1,40})$/.exec(text);
  if (pair) {
    if (pair[1] !== pair[2] && pair[1] === orderNumber) return pair[2];
    if (pair[1] !== pair[2] && pair[2] === orderNumber) return pair[1];
    return undefined;
  }
  const numbers: string[] = text.match(/\d+/g) ?? [];
  if (!numbers.length) return null;
  const annotated = /\p{L}/u.test(text);
  const candidates = new Set(numbers.filter(n => n !== orderNumber && !(annotated && n.length < 8)));
  if (candidates.size !== 1) return undefined;
  const [track] = candidates;
  return track.length >= 8 && track.length <= 40 ? track : undefined;
}

function shipment(raw: Prisma.JsonObject, orderNumber: string): string | null {
  const values: unknown[] = [];
  if (Array.isArray(raw.customFields)) {
    for (const item of raw.customFields) {
      const f = asObject(item);
      const name = String(f?.fieldName || f?.name || '').trim().toLowerCase();
      if (f && ['сдэк трек', 'заказ.сдэк трек'].includes(name)) values.push(f.value, f.valueAsText);
    }
  }
  const tracks = new Set<string>();
  for (const value of values) {
    const track = fieldTrack(String(value ?? ''), orderNumber);
    if (track === undefined) throw new ConflictException('Неоднозначный трек СДЭК');
    if (track !== null) tracks.add(track);
  }
  if (tracks.size > 1) throw new ConflictException('Неоднозначный трек СДЭК');
  return [...tracks][0] ?? null;
}

function quotedKopecks(raw: Prisma.JsonValue | undefined): number | null {
  if (raw == null || raw === '') return null;
  const text = String(raw).trim().replace(',', '.');
  const match = /^(\d{1,12})(?:\.(\d{1,2})0*)?$/.exec(text);
  if ((typeof raw !== 'string' && typeof raw !== 'number') || !match) {
    throw new ConflictException('Некорректная цена доставки для клиента');
  }
  const [, rubles, cents = ''] = match;
  return Number(rubles) * 100 + Number(cents.padEnd(2, '0'));
}

@Controller('cdek/delivery-prices')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.ADMIN)
export class CdekDeliveryPricesController {
  constructor(private prisma: PrismaService, private bridge: BluesalesApiService) {}

  @Get()
  async list(@Query('after') after?: string, @Query('maxId') maxId?: string,
             @Query('existingBefore') existingBefore?: string) {
    const since = activation();
    if (existingBefore !== undefined) {
      if (after !== undefined || maxId !== undefined) throw new BadRequestException('Несовместимые курсоры');
      const before = cursor(existingBefore);
      const rows = await this.prisma.$queryRaw<{ id: number }[]>(Prisma.sql`
        SELECT o.id FROM "Order" o JOIN "BluesalesOrderInfo" b ON b."orderId" = o.id
        WHERE o.source = 'BLUESALES' AND (${before}::int = 0 OR o.id < ${before})
          AND (o."createdAt" <= ${since.toISOString()}::timestamp OR b."bsCreatedAt" IS NULL OR
            b."bsCreatedAt" <= ${since.toISOString()}::timestamp + CASE WHEN b."rawPayload"->>'date' ~ '^[0-9]{2}[.][0-9]{2}[.][0-9]{4}([[:space:]]|$)'
              THEN interval '3 hours' ELSE interval '0 hours' END)
          AND (b."orderStatusId" IS NULL OR b."orderStatusId" NOT IN (${Prisma.join(closedStatuses)}))
          AND EXISTS (SELECT FROM jsonb_array_elements(CASE WHEN jsonb_typeof(b."rawPayload"->'customFields')='array'
                THEN b."rawPayload"->'customFields' ELSE '[]'::jsonb END) f
              WHERE lower(btrim(COALESCE(NULLIF(f->>'fieldName',''),f->>'name'))) IN ('сдэк трек','заказ.сдэк трек')
                AND (NULLIF(btrim(f->>'value'),'') IS NOT NULL OR NULLIF(btrim(f->>'valueAsText'),'') IS NOT NULL))
        ORDER BY o.id DESC LIMIT ${PAGE_SIZE + 1}`);
      const ids = rows.slice(0, PAGE_SIZE).map(row => row.id);
      return { ids, nextBefore: rows.length > PAGE_SIZE ? ids[ids.length - 1] : null };
    }
    const start = cursor(after);
    const where = { source: 'BLUESALES' as const, createdAt: { gt: since },
      bluesalesInfo: { is: { bsCreatedAt: { gt: since },
        OR: [{ orderStatusId: null }, { orderStatusId: { notIn: closedStatuses } }] } } };
    const upper = maxId === undefined
      ? (await this.prisma.order.findFirst({ where, orderBy: { id: 'desc' }, select: { id: true } }))?.id ?? 0
      : cursor(maxId);
    const rows = await this.prisma.order.findMany({ where: { ...where, id: { gt: start, lte: upper } },
      orderBy: { id: 'asc' }, take: PAGE_SIZE + 1, select: { id: true } });
    const ids = rows.slice(0, PAGE_SIZE).map(row => row.id);
    return { ids, maxId: upper, nextAfter: rows.length > PAGE_SIZE ? ids[ids.length - 1] : null };
  }

  @Get(':id')
  async read(@Param('id', ParseIntPipe) id: number, @Query('includeExisting') includeExisting?: string) {
    const since = activation();
    const order = await this.prisma.order.findUnique({ where: { id }, select: { orderNumber: true,
      source: true, createdAt: true, bluesalesInfo: { select: { bsOrderId: true, bsCreatedAt: true,
        orderStatusId: true, rawPayload: true, lastSyncedAt: true } } } });
    const info = order?.bluesalesInfo;
    if (order?.source !== 'BLUESALES' || !info || closedStatuses.includes(info.orderStatusId ?? 0)) {
      throw new NotFoundException();
    }
    const raw = asObject(info.rawPayload);
    if (!raw || String(raw.id) !== String(info.bsOrderId)) throw new ConflictException('Карточка не соответствует заказу');
    // The importer stores DD.MM.YYYY [HH:mm] Moscow wall times as UTC components.
    // With no time, midnight in Moscow is the earliest possible creation time.
    const moscowDate = typeof raw.date === 'string' && /^\d{2}\.\d{2}\.\d{4}(?:\s|$)/.test(raw.date);
    const isNew = !!info.bsCreatedAt && order.createdAt > since &&
      info.bsCreatedAt.getTime() - (moscowDate ? 3 * 3600_000 : 0) > since.getTime();
    if (!isNew && includeExisting !== '1') throw new NotFoundException();
    const field = deliveryField(raw, String(FIELD_ID));
    return { id, scope: isNew ? 'new' : 'existing', orderNumber: order.orderNumber, bsOrderId: info.bsOrderId, tracking: shipment(raw, order.orderNumber),
      quotedKopecks: quotedKopecks(raw.deliveryPrice), ...field, lastSyncedAt: info.lastSyncedAt };
  }

  @Put(':id')
  async write(@Param('id', ParseIntPipe) id: number, @Body() body: PriceUpdate) {
    const existing = body.existingBeforeHandover === true || body.existingBeforeArrival === true;
    const order = await this.read(id, existing ? '1' : undefined);
    if (existing && order.scope !== 'existing') throw new ConflictException('Изменилась дата заказа');
    if (order.bsOrderId !== body.bsOrderId || order.tracking !== body.tracking || order.quotedKopecks !== body.quotedKopecks) {
      throw new ConflictException('Трек или цена изменились');
    }
    const value = differenceText(body.carrierKopecks - body.quotedKopecks);
    if (order.value === value) return { state: 'confirmed', value };
    if (order.value !== body.previousValue || (order.value !== null && !calculatedValue.test(order.value))) {
      throw new ConflictException('Поле сверки изменено вручную');
    }
    // A historical order may already own the waybill, even outside the activation window.
    const matches = await this.prisma.$queryRaw<{ orderNumber: string; value: string }[]>(Prisma.sql`
      SELECT DISTINCT o."orderNumber", v AS value FROM "BluesalesOrderInfo" b JOIN "Order" o ON b."orderId"=o.id
        CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(b."rawPayload"->'customFields')='array'
          THEN b."rawPayload"->'customFields' ELSE '[]'::jsonb END) f
        CROSS JOIN LATERAL unnest(ARRAY[f->>'value', f->>'valueAsText']) v
        WHERE b."orderId" <> ${id} AND strpos(v, ${body.tracking}) > 0
          AND lower(btrim(COALESCE(NULLIF(f->>'fieldName',''),f->>'name'))) IN ('сдэк трек','заказ.сдэк трек')`);
    if (matches.some(row => fieldTrack(row.value, row.orderNumber) === body.tracking)) {
      throw new ConflictException('Трек привязан к другому заказу');
    }
    await this.bridge.setOrderCustomField(body.bsOrderId, FIELD_ID, value, 'background');
    return { state: 'awaiting_sync', value };
  }
}
