import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class CreateOrderDto {
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  orderNumber: string;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  title?: string;
}
