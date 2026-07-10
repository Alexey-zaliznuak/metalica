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

  @Get('revisions/analytics')
  revisionAnalytics(
    @Query('workStartHour') workStartHour?: string,
    @Query('workEndHour') workEndHour?: string,
    @Query('tzOffsetMinutes') tzOffsetMinutes?: string,
  ) {
    return this.metrics.revisionAnalytics({
      workStartHour: this.toNumber(workStartHour),
      workEndHour: this.toNumber(workEndHour),
      tzOffsetMinutes: this.toNumber(tzOffsetMinutes),
    });
  }

  private toNumber(raw?: string): number | undefined {
    if (raw === undefined || raw === '') return undefined;
    const n = Number(raw);
    return Number.isFinite(n) ? n : undefined;
  }
}
