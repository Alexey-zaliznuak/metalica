import { ConfigService } from '@nestjs/config';

/** Единый переключатель импорта из BlueSales; исходящие изменения работают отдельно. */
export function isBluesalesInboundSyncEnabled(config: ConfigService): boolean {
  const raw = config.get<string>('BLUESALES_INBOUND_SYNC_ENABLED');
  if (raw == null || raw === '') return true;
  const value = String(raw).trim().toLowerCase();
  return value === 'true' || value === '1';
}
