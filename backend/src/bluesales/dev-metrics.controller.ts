import { Body, Controller, Get, Patch, Query, UseGuards } from '@nestjs/common';
import { Role, UserScope } from '@prisma/client';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { ScopesGuard } from '../auth/scopes.guard';
import { RequireScopes } from '../auth/scopes.decorator';
import { BluesalesMetricsService } from './bluesales-metrics.service';
import { ImageQueueMetricsService } from '../storage/image-queue-metrics.service';
import { BluesalesInboundSyncService } from './bluesales-inbound-sync';
import { UpdateInboundSyncDto } from './dto/update-inbound-sync.dto';
import { ProductionTaskMetricsService } from '../storage/production-task-metrics.service';

@Controller('dev-metrics')
@UseGuards(JwtAuthGuard, ScopesGuard)
@RequireScopes(UserScope.API_METRICS_VIEW)
export class DevMetricsController {
  constructor(
    private readonly metrics: BluesalesMetricsService,
    private readonly imageMetrics: ImageQueueMetricsService,
    private readonly inboundSync: BluesalesInboundSyncService,
    private readonly productionMetrics: ProductionTaskMetricsService,
  ) {}

  @Get('inbound-sync')
  inboundSyncState() {
    return this.inboundSync.getState();
  }

  @Patch('inbound-sync')
  @UseGuards(RolesGuard)
  @Roles(Role.ADMIN)
  updateInboundSync(@Body() dto: UpdateInboundSyncDto) {
    return this.inboundSync.setEnabled(dto.enabled);
  }

  @Get()
  overview(@Query('date') date?: string) {
    return this.metrics.overview(date);
  }

  @Get('image-queue')
  imageQueue(@Query('hours') hours?: string) {
    return this.imageMetrics.overview(hours);
  }

  @Get('production-debug')
  productionDebug() {
    return this.productionMetrics.overview();
  }
}
