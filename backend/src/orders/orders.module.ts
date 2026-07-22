import { Module } from '@nestjs/common';
import { OrdersService } from './orders.service';
import { OrdersController } from './orders.controller';
import { OrderEventsService } from './order-events.service';
import { BluesalesModule } from '../bluesales/bluesales.module';
import { OrderStatusOutboxProcessor } from './order-status-outbox.processor';

@Module({
  imports: [BluesalesModule],
  providers: [OrdersService, OrderEventsService, OrderStatusOutboxProcessor],
  controllers: [OrdersController],
  exports: [OrdersService],
})
export class OrdersModule {}
