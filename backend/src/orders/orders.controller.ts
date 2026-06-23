import {
  Body,
  Controller,
  Get,
  ParseIntPipe,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { OrdersService } from './orders.service';
import { CreateOrderDto } from './dto/create-order.dto';
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
    @Query('orderStatusIds') orderStatusIds?: string,
    @Query('crmStatusIds') crmStatusIds?: string,
    @Query('q') q?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.orders.findAll(
      orderStatusId !== undefined ? Number(orderStatusId) : undefined,
      orderStatusIds,
      crmStatusIds,
      q,
      page ? Number(page) : undefined,
      limit ? Number(limit) : undefined,
    );
  }

  @Get('order-statuses')
  getOrderStatuses() {
    return this.orders.getOrderStatuses();
  }

  @Get('crm-statuses')
  getCrmStatuses() {
    return this.orders.getCrmStatuses();
  }

  @Post()
  create(@Body() dto: CreateOrderDto) {
    return this.orders.create(dto);
  }

  @Get('assignees')
  getAssignees() {
    return this.orders.getAssignees();
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
  ) {
    return this.orders.updateOrderStatus(id, dto.statusId);
  }

  @Patch(':id/crm-status')
  updateCrmStatus(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateCrmStatusDto,
  ) {
    return this.orders.updateCrmStatus(
      id,
      dto.crmStatusId ?? null,
      dto.crmStatus ?? null,
    );
  }

  @Get(':id/metrics')
  metrics(@Param('id', ParseIntPipe) id: number) {
    return this.orders.getMetrics(id);
  }
}
