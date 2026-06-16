import { Module } from '@nestjs/common';
import { BluesalesApiService } from './bluesales-api.service';
import { BluesalesController } from './bluesales.controller';
import { BluesalesSyncService } from './bluesales-sync.service';

@Module({
  controllers: [BluesalesController],
  providers: [BluesalesApiService, BluesalesSyncService],
  exports: [BluesalesApiService, BluesalesSyncService],
})
export class BluesalesModule {}
