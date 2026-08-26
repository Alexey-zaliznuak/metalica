import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Role, UserScope } from '@prisma/client';

/**
 * Управлять сменами могут администраторы и менеджеры по роли, а остальные
 * пользователи — только с точечно выданным scope.
 */
@Injectable()
export class ShiftManagementGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const { user } = context.switchToHttp().getRequest();
    if (!user) return false;

    if (user.role === Role.ADMIN || user.role === Role.MANAGER) return true;

    const scopes: string[] = user.scopes ?? [];
    if (scopes.includes(UserScope.ARTIST_SHIFTS_MANAGE)) return true;

    throw new ForbiddenException('Нет права управлять сменами художников');
  }
}
