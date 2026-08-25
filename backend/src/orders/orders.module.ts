import { Module } from '@nestjs/common';
import { OrdersService } from './orders.service';
import { OrdersController } from './orders.controller';
import { OrderEventsService } from './order-events.service';
import { AssignmentModule } from '../assignment/assignment.module';
import { BluesalesModule } from '../bluesales/bluesales.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { OrderStatusOutboxProcessor } from './order-status-outbox.processor';

@Module({
  imports: [AssignmentModule, BluesalesModule, NotificationsModule],
  providers: [OrdersService, OrderEventsService, OrderStatusOutboxProcessor],
  controllers: [OrdersController],
  exports: [OrdersService],
})
export class OrdersModule {}
