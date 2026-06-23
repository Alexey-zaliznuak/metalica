import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, MaxLength, Min, ValidateIf } from 'class-validator';

export class UpdateCrmStatusDto {
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @Type(() => Number)
  @IsInt()
  @Min(0)
  crmStatusId?: number | null;

  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsString()
  @MaxLength(200)
  crmStatus?: string | null;
}
