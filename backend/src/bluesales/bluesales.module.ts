import { Module } from '@nestjs/common';
import { AssignmentModule } from '../assignment/assignment.module';
import { GoodsModule } from '../goods/goods.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { BluesalesApiService } from './bluesales-api.service';
import { BluesalesController } from './bluesales.controller';
import { BluesalesDiagController } from './bluesales-diag.controller';
import { BluesalesSyncService } from './bluesales-sync.service';

@Module({
  imports: [AssignmentModule, GoodsModule, NotificationsModule],
  controllers: [BluesalesController, BluesalesDiagController],
  providers: [BluesalesApiService, BluesalesSyncService],
  exports: [BluesalesApiService, BluesalesSyncService],
})
export class BluesalesModule {}
