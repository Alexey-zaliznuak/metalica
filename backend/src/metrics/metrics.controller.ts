import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { MetricsService } from './metrics.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';

@UseGuards(JwtAuthGuard)
@Controller('metrics')
export class MetricsController {
  constructor(private metrics: MetricsService) {}

  @Get('overview')
  overview() {
    return this.metrics.overview();
  }

  @Get('by-designer')
  byDesigner() {
    return this.metrics.byDesigner();
  }

  @Get('workload')
  workload(@Query('orderStatusIds') orderStatusIdsRaw?: string) {
    return this.metrics.workload(orderStatusIdsRaw);
  }
}
