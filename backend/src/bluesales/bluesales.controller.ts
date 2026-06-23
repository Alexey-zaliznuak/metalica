import { Controller, Get, Query } from '@nestjs/common';
import { BluesalesApiService } from './bluesales-api.service';

/**
 * Временный контроллер для ручного тестирования BlueSales API.
 * Удалить после проверки функциональности ids-фильтра.
 */
@Controller('bluesales')
export class BluesalesController {
  constructor(private readonly api: BluesalesApiService) {}

  @Get('pause')
  pauseForFiveMinutes() {
    const pausedUntil = this.api.pauseForMinutes(5);
    return {
      ok: true,
      message: 'Все обращения к BlueSales API приостановлены на 5 минут',
      pausedUntil: pausedUntil.toISOString(),
    };
  }

  @Get('unpause')
  unpause() {
    this.api.unblock();
    return {
      ok: true,
      message: 'Обращения к BlueSales API разблокированы досрочно',
      ...this.api.getPauseState(),
    };
  }

  /**
   * GET /bluesales/test/orders-by-ids?ids=123,456,789
   * Проверяет работу фильтра ids в orders.get
   */
  @Get('test/orders-by-ids')
  async getOrdersByIds(@Query('ids') idsParam: string) {
    const ids = (idsParam ?? '')
      .split(',')
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isFinite(n) && n > 0);

    if (ids.length === 0) {
      return { error: 'Передайте ids=123,456,789 в query-параметрах' };
    }

    const orders = await this.api.getOrdersByIds(ids);

    return {
      requestedIds: ids,
      ...this.api.getPauseState(),
      returnedCount: orders.length,
      returnedIds: orders.map((o) => o.id),
      orders,
    };
  }
}
