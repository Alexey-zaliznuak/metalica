import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Interval } from '@nestjs/schedule';
import { metavistaConfig } from './metavista.config';

@Injectable()
export class EurRateService {
  private readonly logger = new Logger(EurRateService.name);
  private readonly settings;
  private checkedAt = 0;
  private rate: number;
  private source = 'fallback';
  private pending?: Promise<void>;
  constructor(config: ConfigService) {
    this.settings = metavistaConfig(config);
    this.rate = this.settings.fallbackRate;
  }
  @Interval(60_000)
  async poll() { if (this.settings.enabled) await this.current(); }
  async current() {
    if (!this.checkedAt || Date.now() - this.checkedAt >= this.settings.ratePollMs) {
      if (!this.pending) this.pending = this.refresh().finally(() => { this.pending = undefined; });
      await this.pending;
    }
    return { rate: this.rate, source: this.source };
  }
  private async refresh() {
    try {
      const response = await fetch(this.settings.rateUrl, { signal: AbortSignal.timeout(10_000), redirect: 'error' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json() as { Valute?: { EUR?: { Value: number; Nominal: number } } };
      const euro = data.Valute?.EUR;
      const rate = euro && euro.Value / euro.Nominal;
      if (!rate || !Number.isFinite(rate) || rate <= 0 || !euro || euro.Nominal <= 0) throw new Error('Invalid EUR rate');
      this.rate = rate; this.source = 'cbr-xml-daily';
    } catch {
      this.rate = this.settings.fallbackRate; this.source = 'fallback';
      this.logger.warn(`Курс EUR недоступен: используется ${this.rate} RUB`);
    } finally { this.checkedAt = Date.now(); }
  }
}
