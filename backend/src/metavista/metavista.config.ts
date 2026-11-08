import { ConfigService } from '@nestjs/config';

// Verified against the connected Metallica database on 2026-11-08.
// Only credentials and the operational on/off switch belong in .env.
export const METAVISTA_SETTINGS = Object.freeze({
  baseUrl: 'https://metavista.es/api/integrations/crm/v1',
  importHistory: true, pollMs: 60_000, pageSize: 10, timeoutMs: 30_000,
  maxFileBytes: 100 * 1024 * 1024,
  fallbackGoodsId: 493830, // Existing general product «Фотопечать» for an unmatched basket.
  statusName: 'Новый (ждем фото)', statusId: 145338,
  tagName: 'ИСПАНИЯ', tagId: 728420,
  rateUrl: 'https://www.cbr-xml-daily.ru/daily_json.js',
  ratePollMs: 3_600_000, fallbackRate: 90,
});

export function metavistaConfig(config: ConfigService) {
  return {
    ...METAVISTA_SETTINGS,
    enabled: String(config.get('METAVISTA_ENABLED', 'false')).trim() === 'true',
    key: String(config.get('METAVISTA_API_KEY', '')).trim(),
  };
}
