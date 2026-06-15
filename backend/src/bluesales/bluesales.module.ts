import { Module } from '@nestjs/common';
import { BluesalesApiService } from './bluesales-api.service';
import { BluesalesSyncService } from './bluesales-sync.service';

@Module({
  providers: [BluesalesApiService, BluesalesSyncService],
  exports: [BluesalesApiService, BluesalesSyncService],
})
export class BluesalesModule {}
