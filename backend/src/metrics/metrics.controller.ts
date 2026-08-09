import { BadRequestException, Controller, Get, Query, UseGuards } from '@nestjs/common';
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
  workload(
    @Query('orderStatusIds') orderStatusIdsRaw?: string,
    @Query('onlyOpenSketch') onlyOpenSketchRaw?: string,
    @Query('dateFrom') dateFromRaw?: string,
    @Query('dateTo') dateToRaw?: string,
  ) {
    return this.metrics.workload(
      orderStatusIdsRaw,
      onlyOpenSketchRaw === 'true',
      this.toDateRange(dateFromRaw, dateToRaw),
    );
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

  private toDateRange(
    dateFromRaw?: string,
    dateToRaw?: string,
  ): { from: Date; to: Date } | undefined {
    if (!dateFromRaw && !dateToRaw) return undefined;
    if (!dateFromRaw || !dateToRaw) {
      throw new BadRequestException('Для периода необходимо указать dateFrom и dateTo');
    }

    const from = new Date(dateFromRaw);
    const to = new Date(dateToRaw);
    if (
      Number.isNaN(from.getTime()) ||
      Number.isNaN(to.getTime()) ||
      from.getTime() >= to.getTime()
    ) {
      throw new BadRequestException('Указан некорректный период');
    }
    return { from, to };
  }
}
