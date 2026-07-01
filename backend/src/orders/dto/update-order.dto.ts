import {
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

export class UpdateOrderDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  orderNumber?: string;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  title?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  dialogLink?: string | null;

  @IsOptional()
  @IsInt()
  @Min(1)
  sketchDesignerId?: number | null;

  @IsOptional()
  @IsInt()
  @Min(1)
  revisionDesignerId?: number | null;
}
