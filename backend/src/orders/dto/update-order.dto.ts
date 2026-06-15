import { IsEnum, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { OrderStatus } from '@prisma/client';

export class UpdateOrderDto {
  @IsOptional()
  @IsEnum(OrderStatus)
  status?: OrderStatus;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  orderNumber?: string;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  title?: string;
}
