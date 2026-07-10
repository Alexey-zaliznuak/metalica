import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Role, UserScope } from '@prisma/client';
import { SCOPES_KEY } from './scopes.decorator';

@Injectable()
export class ScopesGuard implements CanActivate {
  constructor(private reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const requiredScopes = this.reflector.getAllAndOverride<UserScope[]>(
      SCOPES_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (!requiredScopes || requiredScopes.length === 0) {
      return true;
    }
    const { user } = context.switchToHttp().getRequest();
    if (!user) {
      return false;
    }
    // ADMIN всегда имеет доступ, независимо от набора скоупов.
    if (user.role === Role.ADMIN) {
      return true;
    }
    const scopes: string[] = user.scopes ?? [];
    const hasScope = requiredScopes.some((scope) => scopes.includes(scope));
    if (!hasScope) {
      throw new ForbiddenException('Недостаточно прав для доступа к разделу');
    }
    return true;
  }
}
