import { SetMetadata } from '@nestjs/common';
import { UserScope } from '@prisma/client';

export const SCOPES_KEY = 'scopes';
export const RequireScopes = (...scopes: UserScope[]) =>
  SetMetadata(SCOPES_KEY, scopes);
