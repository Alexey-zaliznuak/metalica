import { Body, Controller, Get, Patch, Query, UseGuards } from '@nestjs/common';
import { Role } from '@prisma/client';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { BluesalesMetricsService } from './bluesales-metrics.service';
import { ImageQueueMetricsService } from '../storage/image-queue-metrics.service';
import { BluesalesInboundSyncService } from './bluesales-inbound-sync';
import { UpdateInboundSyncDto } from './dto/update-inbound-sync.dto';

@Controller('dev-metrics')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.ADMIN)
export class DevMetricsController {
  constructor(
    private readonly metrics: BluesalesMetricsService,
    private readonly imageMetrics: ImageQueueMetricsService,
    private readonly inboundSync: BluesalesInboundSyncService,
  ) {}

  @Get('inbound-sync')
  inboundSyncState() {
    return this.inboundSync.getState();
  }

  @Patch('inbound-sync')
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
}
