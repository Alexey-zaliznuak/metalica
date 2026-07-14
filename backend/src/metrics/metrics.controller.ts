import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { UserScope } from '@prisma/client';
import { MetricsService } from './metrics.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { ScopesGuard } from '../auth/scopes.guard';
import { RequireScopes } from '../auth/scopes.decorator';

@UseGuards(JwtAuthGuard, ScopesGuard)
@Controller('metrics')
export class MetricsController {
  constructor(private metrics: MetricsService) {}

  @Get('overview')
  @RequireScopes(UserScope.METRICS_VIEW)
  overview() {
    return this.metrics.overview();
  }

  @Get('by-designer')
  @RequireScopes(UserScope.METRICS_VIEW)
  byDesigner() {
    return this.metrics.byDesigner();
  }

  @Get('workload')
  @RequireScopes(UserScope.WORKLOAD_VIEW)
  workload(@Query('orderStatusIds') orderStatusIdsRaw?: string) {
    return this.metrics.workload(orderStatusIdsRaw);
  }

  @Get('revisions/analytics')
  @RequireScopes(UserScope.METRICS_VIEW)
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

  @Get('sketches/analytics')
  @RequireScopes(UserScope.METRICS_VIEW)
  sketchAnalytics(
    @Query('workStartHour') workStartHour?: string,
    @Query('workEndHour') workEndHour?: string,
    @Query('tzOffsetMinutes') tzOffsetMinutes?: string,
  ) {
    return this.metrics.sketchAnalytics({
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
