import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { Role } from '@prisma/client';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { BluesalesMetricsService } from './bluesales-metrics.service';

@Controller('dev-metrics')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.ADMIN)
export class DevMetricsController {
  constructor(private readonly metrics: BluesalesMetricsService) {}

  @Get()
  overview(@Query('date') date?: string) {
    return this.metrics.overview(date);
  }
}
