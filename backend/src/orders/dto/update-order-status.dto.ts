import { Type } from 'class-transformer';
import { IsInt, Min } from 'class-validator';

export class UpdateOrderStatusDto {
  @Type(() => Number)
  @IsInt()
  @Min(0)
  statusId: number;
}
