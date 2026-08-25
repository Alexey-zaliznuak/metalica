import { IsArray, IsEnum, IsOptional, IsString, MinLength } from 'class-validator';
import { OrderDirection, Role, UserScope } from '@prisma/client';

export class CreateUserDto {
  @IsString()
  @MinLength(3)
  username: string;

  @IsString()
  @MinLength(1)
  name: string;

  @IsString()
  @MinLength(6)
  password: string;

  @IsOptional()
  @IsEnum(Role)
  role?: Role;

  @IsOptional()
  @IsArray()
  @IsEnum(UserScope, { each: true })
  scopes?: UserScope[];

  // Направления, в которых художник участвует в автораспределении.
  @IsOptional()
  @IsArray()
  @IsEnum(OrderDirection, { each: true })
  directions?: OrderDirection[];
}
