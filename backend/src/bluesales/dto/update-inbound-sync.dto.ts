import { IsBoolean } from 'class-validator';

export class UpdateInboundSyncDto {
  @IsBoolean()
  enabled!: boolean;
}
