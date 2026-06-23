import { IsObject } from 'class-validator';

export class UpdateFrontendSettingsDto {
  @IsObject()
  frontendSettings: Record<string, unknown>;
}
