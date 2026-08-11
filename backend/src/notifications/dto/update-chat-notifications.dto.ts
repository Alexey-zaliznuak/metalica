import { IsBoolean } from 'class-validator';

export class UpdateChatNotificationsDto {
  @IsBoolean()
  enabled!: boolean;
}
