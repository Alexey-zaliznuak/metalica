import { Type } from 'class-transformer';
import {
  IsArray,
  IsInt,
  IsString,
  Min,
  ValidateNested,
} from 'class-validator';

export class NotificationStatusSettingDto {
  @IsInt()
  @Min(1)
  statusId!: number;

  @IsArray()
  @IsString({ each: true })
  deliveryManagerNames!: string[];

  @IsArray()
  @IsString({ each: true })
  onboardingManagerNames!: string[];

  @IsArray()
  @IsString({ each: true })
  sketchDesignerNames!: string[];

  @IsArray()
  @IsString({ each: true })
  revisionDesignerNames!: string[];
}

export class UpdateNotificationSettingsDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => NotificationStatusSettingDto)
  statuses!: NotificationStatusSettingDto[];
}
