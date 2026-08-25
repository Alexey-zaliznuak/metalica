import { IsBoolean } from 'class-validator';

export class UpdateShiftDto {
  @IsBoolean()
  onShift: boolean;
}
