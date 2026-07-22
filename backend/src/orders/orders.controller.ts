import {
  Body,
  Controller,
  Get,
  ParseIntPipe,
  Param,
  Patch,
  Query,
  UseGuards,
} from '@nestjs/common';
import { OrdersService } from './orders.service';
import { UpdateOrderDto } from './dto/update-order.dto';
import { UpdateOrderStatusDto } from './dto/update-order-status.dto';
import { UpdateCrmStatusDto } from './dto/update-crm-status.dto';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AuthUser, CurrentUser } from '../auth/current-user.decorator';

@UseGuards(JwtAuthGuard)
@Controller('orders')
export class OrdersController {
  constructor(private orders: OrdersService) {}

  @Get()
  findAll(
    @Query('orderStatusId') orderStatusId?: string,
    @Query('noStatus') noStatus?: string,
    @Query('q') q?: string,
    @Query('deliveryManagers') deliveryManagers?: string | string[],
    @Query('onboardingManagers') onboardingManagers?: string | string[],
    @Query('sketchDesigners') sketchDesigners?: string | string[],
    @Query('revisionDesigners') revisionDesigners?: string | string[],
    @Query('ignoreDesigners') ignoreDesigners?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    const toArray = (value?: string | string[]): string[] | undefined => {
      if (value == null) return undefined;
      const arr = Array.isArray(value) ? value : [value];
      const cleaned = arr.map((v) => v.trim()).filter((v) => v.length > 0);
      return cleaned.length > 0 ? cleaned : undefined;
    };

    return this.orders.findAll({
      orderStatusId:
        orderStatusId !== undefined && orderStatusId !== ''
          ? Number(orderStatusId)
          : undefined,
      noStatus: noStatus === 'true' || noStatus === '1',
      q,
      deliveryManagers: toArray(deliveryManagers),
      onboardingManagers: toArray(onboardingManagers),
      sketchDesigners: toArray(sketchDesigners),
      revisionDesigners: toArray(revisionDesigners),
      ignoreDesigners: ignoreDesigners === 'true' || ignoreDesigners === '1',
      page: page ? Number(page) : undefined,
      limit: limit ? Number(limit) : undefined,
    });
  }

  @Get('filter-options')
  getFilterOptions() {
    return this.orders.getManagerOptions();
  }

  @Get('order-statuses')
  getOrderStatuses() {
    return this.orders.getOrderStatuses();
  }

  @Get('tags')
  getTags() {
    return this.orders.getTags();
  }

  @Get('crm-statuses')
  getCrmStatuses() {
    return this.orders.getCrmStatuses();
  }

  @Get('assignees')
  getAssignees() {
    return this.orders.getAssignees();
  }

  @Get('status-sync')
  getOrderStatusSync(@Query('ids') ids?: string) {
    return this.orders.getOrderStatusSync(
      (ids ?? '')
        .split(',')
        .map((id) => Number(id))
        .filter(Number.isInteger),
    );
  }

  @Get(':id')
  findOne(@Param('id', ParseIntPipe) id: number) {
    return this.orders.findOne(id);
  }

  @Patch(':id')
  update(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateOrderDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.orders.update(id, dto, user);
  }

  @Patch(':id/order-status')
  updateOrderStatus(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateOrderStatusDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.orders.updateOrderStatus(id, dto.statusId, user);
  }

  @Patch(':id/crm-status')
  updateCrmStatus(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateCrmStatusDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.orders.updateCrmStatus(
      id,
      dto.crmStatusId ?? null,
      dto.crmStatus ?? null,
      user,
    );
  }

  @Get(':id/metrics')
  metrics(@Param('id', ParseIntPipe) id: number) {
    return this.orders.getMetrics(id);
  }

  @Get(':id/events')
  events(@Param('id', ParseIntPipe) id: number) {
    return this.orders.getEvents(id);
  }
}
