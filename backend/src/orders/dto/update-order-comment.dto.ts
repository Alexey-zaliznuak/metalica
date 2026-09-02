import { IsString, MaxLength } from 'class-validator';

export class UpdateOrderCommentDto {
  @IsString()
  @MaxLength(5000)
  comment: string;
}
