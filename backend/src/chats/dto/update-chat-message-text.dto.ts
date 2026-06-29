import { IsString, MaxLength } from 'class-validator';

export class UpdateChatMessageTextDto {
  @IsString()
  @MaxLength(5000)
  body: string;
}
