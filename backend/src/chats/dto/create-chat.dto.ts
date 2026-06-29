import { ChatType } from '@prisma/client';
import { IsArray, IsEnum, IsInt, IsOptional, IsString, MaxLength } from 'class-validator';

export class CreateChatDto {
  @IsString()
  @MaxLength(120)
  name: string;

  @IsOptional()
  @IsEnum(ChatType)
  type?: ChatType;

  @IsOptional()
  @IsArray()
  @IsInt({ each: true })
  memberIds?: number[];
}
