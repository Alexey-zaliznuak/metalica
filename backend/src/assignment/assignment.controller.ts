import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { UserScope } from '@prisma/client';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RequireScopes } from '../auth/scopes.decorator';
import { ScopesGuard } from '../auth/scopes.guard';
import { AssignmentService } from './assignment.service';

@UseGuards(JwtAuthGuard, ScopesGuard)
@Controller('assignment')
export class AssignmentController {
  constructor(private assignment: AssignmentService) {}

  @Get('journal')
  @RequireScopes(UserScope.WORKLOAD_VIEW)
  journal(
    @Query('limit') limitRaw?: string,
    @Query('before') beforeRaw?: string,
    @Query('role') roleRaw?: string,
    @Query('source') sourceRaw?: string,
    @Query('q') q?: string,
  ) {
    const limit = Number(limitRaw);
    const before = Number(beforeRaw);
    const role = roleRaw === 'sketch' || roleRaw === 'revision' ? roleRaw : undefined;
    const source = sourceRaw === 'auto' || sourceRaw === 'manual' ? sourceRaw : undefined;

    return this.assignment.journal({
      limit: Number.isFinite(limit) ? limit : undefined,
      before: Number.isInteger(before) ? before : undefined,
      role,
      source,
      q,
    });
  }
}
