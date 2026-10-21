import { Module } from '@nestjs/common';
import { AssignmentModule } from '../assignment/assignment.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { BluesalesApiService } from './bluesales-api.service';
import { BluesalesController } from './bluesales.controller';
import { BluesalesDiagController } from './bluesales-diag.controller';
import { BluesalesSyncService } from './bluesales-sync.service';
import { BluesalesMetricsService } from './bluesales-metrics.service';
import { DevMetricsController } from './dev-metrics.controller';
import { BluesalesInboundSyncService } from './bluesales-inbound-sync';

@Module({
  imports: [AssignmentModule, NotificationsModule],
  controllers: [BluesalesController, BluesalesDiagController, DevMetricsController],
  providers: [BluesalesApiService, BluesalesSyncService, BluesalesMetricsService, BluesalesInboundSyncService],
  exports: [BluesalesApiService, BluesalesSyncService, BluesalesInboundSyncService],
})
export class BluesalesModule {}
