import { ChatMemberRole } from '@prisma/client';
import { IsEnum, IsInt, IsOptional } from 'class-validator';

export class AddChatMemberDto {
  @IsInt()
  userId: number;

  @IsOptional()
  @IsEnum(ChatMemberRole)
  role?: ChatMemberRole;
}
