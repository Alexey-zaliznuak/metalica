import { Module } from '@nestjs/common';
import { OrdersService } from './orders.service';
import { OrdersController } from './orders.controller';
import { OrderEventsService } from './order-events.service';
import { AssignmentModule } from '../assignment/assignment.module';
import { BluesalesModule } from '../bluesales/bluesales.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { OrderStatusOutboxProcessor } from './order-status-outbox.processor';
import { ProductionFilesService } from './production-files.service';
import { OrderLifecycleService } from './order-lifecycle.service';
import { OrderAttachmentCleanupWorker, OrderAutoCompleteWorker } from './order-lifecycle.workers';

@Module({
  imports: [AssignmentModule, BluesalesModule, NotificationsModule],
  providers: [OrdersService, OrderEventsService, OrderStatusOutboxProcessor, ProductionFilesService, OrderLifecycleService, OrderAttachmentCleanupWorker, OrderAutoCompleteWorker],
  controllers: [OrdersController],
  exports: [OrdersService],
})
export class OrdersModule {}
