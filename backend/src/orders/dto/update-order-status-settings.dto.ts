import { Type } from 'class-transformer';
import { IsBoolean, IsInt, IsOptional, Max, Min, ValidateIf } from 'class-validator';

// Год в минутах — верхняя граница порога, чтобы не хранить бессмысленные значения.
const MAX_ALERT_MINUTES = 60 * 24 * 365;

export class UpdateOrderStatusSettingsDto {
  @IsBoolean()
  showTimeInStatus: boolean;

  @IsOptional()
  @IsBoolean()
  closesSketch?: boolean;

  // Нужно ли при входе заказа в статус подобрать художника автоматически.
  @IsOptional()
  @IsBoolean()
  assignSketchDesigner?: boolean;

  @IsOptional()
  @IsBoolean()
  assignRevisionDesigner?: boolean;

  // null/отсутствует = порог не задан: таймер показывается без «огонька».
  @ValidateIf(
    (dto: UpdateOrderStatusSettingsDto) =>
      dto.alertAfterMinutes !== null && dto.alertAfterMinutes !== undefined,
  )
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_ALERT_MINUTES)
  alertAfterMinutes?: number | null;
}
