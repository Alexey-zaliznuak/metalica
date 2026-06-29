import { IsArray, IsOptional, IsString, MaxLength } from 'class-validator';

export class CreateChatMessageDto {
  @IsOptional()
  @IsString()
  @MaxLength(5000)
  body?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  attachmentKeys?: string[];
}
