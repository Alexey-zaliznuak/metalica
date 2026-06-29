import { IsString, MaxLength } from 'class-validator';

export class UpdateMessageTextDto {
  @IsString()
  @MaxLength(5000)
  body: string;
}
