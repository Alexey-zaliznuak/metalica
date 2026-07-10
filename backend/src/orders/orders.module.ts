import { Module } from '@nestjs/common';
import { OrdersService } from './orders.service';
import { OrdersController } from './orders.controller';
import { OrderEventsService } from './order-events.service';
import { BluesalesModule } from '../bluesales/bluesales.module';

@Module({
  imports: [BluesalesModule],
  providers: [OrdersService, OrderEventsService],
  controllers: [OrdersController],
  exports: [OrdersService],
})
export class OrdersModule {}
