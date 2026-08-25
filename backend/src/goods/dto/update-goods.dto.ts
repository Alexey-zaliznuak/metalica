import { OrderDirection } from '@prisma/client';
import { IsEnum, IsOptional, ValidateIf } from 'class-validator';

export class UpdateGoodsDto {
  // null = товар не влияет на направление заказа (доп, упаковка, срочность и т.п.)
  @IsOptional()
  @ValidateIf((_dto, value) => value !== null)
  @IsEnum(OrderDirection)
  direction?: OrderDirection | null;
}
