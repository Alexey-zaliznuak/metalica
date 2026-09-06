import {
  IsArray,
  IsDateString,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
} from 'class-validator';

export class UpdateOrderDto {
  @IsOptional()
  @IsInt()
  @Min(1)
  finalSketchMessageId?: number | null;

  @ValidateIf((_, value) => value !== undefined)
  @IsArray()
  @IsString({ each: true })
  @MinLength(1, { each: true })
  @MaxLength(1024, { each: true })
  printPhotoKeys?: string[];

  @ValidateIf((_, value) => value !== undefined)
  @IsArray()
  @IsInt({ each: true })
  @Min(1, { each: true })
  removePrintPhotoIds?: number[];

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
  @MaxLength(5000)
  note?: string | null;

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

  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsDateString()
  sketchStartedAt?: string | null;

  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsDateString()
  sketchReadyAt?: string | null;
}
