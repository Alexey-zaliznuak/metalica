import { ArrayUnique, IsArray, IsInt, Min } from 'class-validator';

export class UpdateNotificationSettingsDto {
  @IsArray()
  @ArrayUnique()
  @IsInt({ each: true })
  @Min(1, { each: true })
  orderStatusIds!: number[];
}
