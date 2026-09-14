import { Module } from '@nestjs/common';
import { AssignmentModule } from '../assignment/assignment.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { BluesalesApiService } from './bluesales-api.service';
import { BluesalesController } from './bluesales.controller';
import { BluesalesDiagController } from './bluesales-diag.controller';
import { BluesalesSyncService } from './bluesales-sync.service';
import { BluesalesMetricsService } from './bluesales-metrics.service';
import { DevMetricsController } from './dev-metrics.controller';

@Module({
  imports: [AssignmentModule, NotificationsModule],
  controllers: [BluesalesController, BluesalesDiagController, DevMetricsController],
  providers: [BluesalesApiService, BluesalesSyncService, BluesalesMetricsService],
  exports: [BluesalesApiService, BluesalesSyncService],
})
export class BluesalesModule {}
