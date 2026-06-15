import {
  IsArray,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { MessageKind } from '@prisma/client';

export class CreateMessageDto {
  @IsOptional()
  @IsString()
  @MaxLength(5000)
  body?: string;

  @IsEnum(MessageKind)
  kind: MessageKind;

  @IsOptional()
  @IsInt()
  answerToId?: number;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  attachmentKeys?: string[];
}
