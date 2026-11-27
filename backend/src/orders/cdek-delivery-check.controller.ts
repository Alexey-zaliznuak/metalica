import {
  Body, ConflictException, Controller, Get, NotFoundException, Param, ParseIntPipe,
  Put, UseGuards,
} from '@nestjs/common';
import { Role } from '@prisma/client';
import { IsBoolean, IsInt, IsOptional, Max, Min } from 'class-validator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { BluesalesApiService } from '../bluesales/bluesales-api.service';
import { PrismaService } from '../prisma/prisma.service';

import { deliveryField, differenceText, positiveId } from './cdek-delivery-field';

class DeliveryDifferenceDto {
  @IsInt()
  @Min(Number.MIN_SAFE_INTEGER)
  @Max(Number.MAX_SAFE_INTEGER)
  differenceKopecks!: number;

  @IsOptional()
  @IsBoolean()
  replaceTestMarker?: boolean;
}

@Controller('orders/:id/cdek-delivery-check')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.ADMIN)
export class CdekDeliveryCheckController {
  constructor(private prisma: PrismaService, private bridge: BluesalesApiService) {}

  private async snapshot(id: number) {
    const allowed = positiveId(process.env.CDEK_DELIVERY_CHECK_TEST_BS_ORDER_ID);
    if (!allowed) throw new NotFoundException();
    const order = await this.prisma.order.findUnique({
      where: { id },
      select: { source: true, orderNumber: true, bluesalesInfo: {
        select: { bsOrderId: true, rawPayload: true, lastSyncedAt: true },
      } },
    });
    const info = order?.bluesalesInfo;
    if (order?.source !== 'BLUESALES' || !info || info.bsOrderId !== allowed) {
      throw new NotFoundException();
    }
    return { id, orderNumber: order.orderNumber, bsOrderId: info.bsOrderId,
      ...deliveryField(info.rawPayload), lastSyncedAt: info.lastSyncedAt };
  }

  @Get()
  read(@Param('id', ParseIntPipe) id: number) {
    return this.snapshot(id);
  }

  @Put()
  async write(@Param('id', ParseIntPipe) id: number, @Body() body: DeliveryDifferenceDto) {
    const field = await this.snapshot(id);
    const value = differenceText(body.differenceKopecks);
    if (field.value === value) return { state: 'confirmed', value };
    if (body.replaceTestMarker === true) {
      const previousExample = field.value === '🔴 Разница +80,00 ₽';
      if ((field.value !== 'ТЕСТ СВЕРКИ' && !previousExample) || body.differenceKopecks !== 50_000) {
        throw new ConflictException('Тестовая метка или согласованная сумма изменились');
      }
    } else if (field.value !== null) {
      throw new ConflictException('В тестовом поле уже есть другое значение');
    }
    await this.bridge.setOrderCustomField(field.bsOrderId, field.fieldId, value, 'interactive');
    return { state: 'awaiting_sync', value };
  }
}
