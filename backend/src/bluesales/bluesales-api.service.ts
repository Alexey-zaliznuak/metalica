import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'crypto';

/**
 * Низкоуровневый клиент BlueSales — TS-порт питоновского RequestApi.
 *
 * Важно: BlueSales допускает только одну активную сессию на логин. При
 * параллельных запросах API возвращает ошибку «Другой пользователь находится
 * онлайн под логином ... <span class='countdown'>N</span>». Поэтому все
 * запросы сериализуются через внутреннюю очередь (mutex), а на countdown-ошибку
 * выполняется ожидание N+1 секунд и повтор.
 */

const BASE_URL = 'https://bluesales.ru/app/Customers/WebServer.aspx';

export class BluesalesError extends Error {}
export class BluesalesHttpError extends BluesalesError {}
export class BluesalesAuthError extends BluesalesError {}

export interface BsOrderStatus {
  id?: number;
  name?: string;
}

export interface BsCrmStatus {
  id?: number;
  name?: string;
}

export interface BsVkInfo {
  id?: string;
  name?: string;
  // id сообщества, под которым ведётся переписка с лидом
  messagesGroupId?: string;
}

export interface BsManager {
  id?: number;
  fullName?: string;
  email?: string;
  login?: string;
}

export interface BsCustomField {
  fieldId?: number;
  fieldName?: string;
  value?: unknown;
  valueAsText?: string;
}

export interface BsCustomer {
  id?: number;
  fullName?: string;
  vk?: BsVkInfo | null;
  crmStatus?: BsCrmStatus | null;
  salesChannel?: { id?: number; code?: number; name?: string } | null;
  // Менеджер клиента в BlueSales — источник «менеджера ведения».
  manager?: BsManager | null;
  [key: string]: unknown;
}

export interface BsOrder {
  id: number;
  internalNumber?: number | string | null;
  externalNumber?: number | string | null;
  trackingNumber?: string | null;
  date?: string | null;
  orderStatus?: BsOrderStatus | null;
  totalSumMinusDiscount?: number | null;
  customer?: BsCustomer | null;
  manager?: BsManager | null;
  // Кастомные поля заказа BlueSales; среди них «Оформление» — менеджер оформления.
  customFields?: BsCustomField[] | null;
  [key: string]: unknown;
}

export interface GetOrdersResponse {
  count: number;
  notReturnedCount: number;
  orders: BsOrder[];
}

export interface GetCustomersResponse {
  count: number;
  notReturnedCount: number;
  customers: BsCustomer[];
}

interface SetOrderStatusPayload {
  orderId?: number;
  id?: number;
  status: number;
}

const MAX_PAGE_SIZE = 500;

@Injectable()
export class BluesalesApiService {
  private readonly logger = new Logger(BluesalesApiService.name);
  private readonly login: string;
  private readonly passwordHash: string;
  private pausedUntilTs: number | null = null;

  // Очередь сериализации запросов (single-session на логин)
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly config: ConfigService) {
    this.login = this.config.get<string>('BLUESALES_LOGIN', '');
    const password = this.config.get<string>('BLUESALES_PASSWORD', '');
    this.passwordHash = password ? this.hashPassword(password) : '';
  }

  get isConfigured(): boolean {
    return Boolean(this.login && this.passwordHash);
  }

  private hashPassword(password: string): string {
    return createHash('md5').update(password, 'utf-8').digest('hex').toUpperCase();
  }

  /** Сериализует вызовы: каждый запрос ждёт завершения предыдущего. */
  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.chain.then(task, task);
    // не даём отклонению одного запроса сломать всю цепочку
    this.chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async sleep(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  private getPauseRemainingMs(): number {
    if (!this.pausedUntilTs) {
      return 0;
    }
    return Math.max(0, this.pausedUntilTs - Date.now());
  }

  private async waitIfPaused(): Promise<void> {
    while (true) {
      const remainingMs = this.getPauseRemainingMs();
      if (remainingMs <= 0) {
        this.pausedUntilTs = null;
        return;
      }

      this.logger.warn(
        `BlueSales API временно заблокирован, ожидание ${Math.ceil(remainingMs / 1000)}с`,
      );
      await this.sleep(Math.min(remainingMs, 1000));
    }
  }

  private parseCountdown(error: string): number | null {
    const open = "<span class='countdown'>";
    const close = '</span>';
    const i1 = error.indexOf(open);
    const i2 = error.indexOf(close);
    if (i1 === -1 || i2 === -1) {
      return null;
    }
    const raw = error.slice(i1 + open.length, i2);
    const seconds = Number.parseInt(raw, 10);
    return Number.isFinite(seconds) ? seconds : null;
  }

  private async sendRaw<T>(method: string, data?: unknown, attempt = 1): Promise<T> {
    if (!this.isConfigured) {
      throw new BluesalesAuthError('BlueSales credentials are not configured');
    }

    const url = new URL(BASE_URL);
    url.searchParams.set('login', this.login);
    url.searchParams.set('password', this.passwordHash);
    url.searchParams.set('command', method);

    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data ?? null),
      });
    } catch (err) {
      throw new BluesalesHttpError(
        `Error connecting to bluesales.ru API: ${(err as Error).message}`,
      );
    }

    if (response.status === 404) {
      throw new BluesalesHttpError(`Method ${method} not found!`);
    }

    const text = await response.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new BluesalesError(`Invalid JSON from BlueSales: ${text.slice(0, 200)}`);
    }

    if (
      parsed &&
      typeof parsed === 'object' &&
      'isValid' in parsed &&
      (parsed as { isValid?: boolean }).isValid === false
    ) {
      const errorObj = parsed as { error?: string };
      const errorText = errorObj.error ?? '';

      if (errorText === 'Неправильный логин или пароль.') {
        throw new BluesalesAuthError(errorText);
      }

      if (errorText.includes('Другой пользователь находится онлайн под логином')) {
        const delay = this.parseCountdown(errorText);
        if (delay !== null) {
          this.logger.warn(
            `BlueSales: другая сессия онлайн, ждём ${delay + 1}s и повторяем`,
          );
          await this.sleep((delay + 1) * 1000);
          return this.sendRaw<T>(method, data, attempt);
        }
      }

      // Другой пользователь организации уже выполняет запрос — ждём и повторяем.
      if (errorText.includes('Уже выполняется одно или несколько других обращений к API')) {
        const MAX_ATTEMPTS = 20;
        if (attempt <= MAX_ATTEMPTS) {
          // Первые 5 попыток — быстро (до 30с), потом фиксированные 30с паузы.
          const delaySec = Math.min(attempt * 3, 30);
          this.logger.warn(
            `BlueSales: параллельный запрос в организации, ждём ${delaySec}s (попытка ${attempt}/${MAX_ATTEMPTS})`,
          );
          await this.sleep(delaySec * 1000);
          return this.sendRaw<T>(method, data, attempt + 1);
        }
      }

      throw new BluesalesError(`${this.login} | ${JSON.stringify(parsed)}`);
    }

    return parsed as T;
  }

  /** Публичный отправитель — все вызовы проходят через очередь. */
  send<T>(method: string, data?: unknown): Promise<T> {
    return this.enqueue(async () => {
      await this.waitIfPaused();
      return this.sendRaw<T>(method, data);
    });
  }

  pauseForMinutes(minutes: number): Date {
    const durationMs = Math.max(1, Math.floor(minutes)) * 60 * 1000;
    this.pausedUntilTs = Date.now() + durationMs;
    const until = new Date(this.pausedUntilTs);
    this.logger.warn(`BlueSales API заблокирован до ${until.toISOString()}`);
    return until;
  }

  unblock(): void {
    this.pausedUntilTs = null;
    this.logger.warn('BlueSales API разблокирован досрочно');
  }

  getPauseState(): { isPaused: boolean; pausedUntil: string | null; remainingSeconds: number } {
    const remainingMs = this.getPauseRemainingMs();
    return {
      isPaused: remainingMs > 0,
      pausedUntil: remainingMs > 0 ? new Date((this.pausedUntilTs as number)).toISOString() : null,
      remainingSeconds: Math.ceil(remainingMs / 1000),
    };
  }

  private formatDate(date: Date): string {
    const y = date.getUTCFullYear();
    const m = `${date.getUTCMonth() + 1}`.padStart(2, '0');
    const d = `${date.getUTCDate()}`.padStart(2, '0');
    return `${y}-${m}-${d}`;
  }

  /** Получить конкретные заказы по списку BS-идентификаторов (до 500 штук). */
  async getOrdersByIds(ids: number[]): Promise<BsOrder[]> {
    if (ids.length === 0) return [];
    const result = await this.send<GetOrdersResponse>('orders.get', {
      dateFrom: null,
      dateTill: null,
      orderStatuses: [],
      customerId: null,
      ids,
      internalNumbers: null,
      pageSize: ids.length,
      startRowNumber: 0,
    });
    return result.orders ?? [];
  }

  /** Постранично получить все заказы за период [dateFrom, dateTo]. */
  async getOrders(dateFrom?: Date, dateTo?: Date): Promise<BsOrder[]> {
    const baseData = {
      dateFrom: dateFrom ? this.formatDate(dateFrom) : null,
      // BS трактует dateTill как «до начала дня», поэтому +1 день включительно
      dateTill: dateTo
        ? this.formatDate(new Date(dateTo.getTime() + 24 * 60 * 60 * 1000))
        : null,
      orderStatuses: [] as unknown[],
      customerId: null,
      ids: null,
      internalNumbers: null,
    };

    const first = await this.send<GetOrdersResponse>('orders.get', {
      ...baseData,
      pageSize: 1,
      startRowNumber: 0,
    });
    const total = (first.notReturnedCount ?? 0) + (first.count ?? 0);
    if (total === 0) {
      return [];
    }

    const items: BsOrder[] = [];
    let offset = 0;
    while (items.length < total) {
      const page = await this.send<GetOrdersResponse>('orders.get', {
        ...baseData,
        pageSize: MAX_PAGE_SIZE,
        startRowNumber: offset,
      });
      items.push(...(page.orders ?? []));
      offset += MAX_PAGE_SIZE;
      if (!page.orders || page.orders.length === 0) {
        break;
      }
    }
    return items;
  }

  /**
   * Изменяет статус заказа в BlueSales.
   * В API встречаются разные имена ключа id, поэтому пробуем оба варианта.
   */
  async setOrderStatus(orderId: number, statusId: number): Promise<void> {
    const payloads: SetOrderStatusPayload[] = [
      { orderId, status: statusId },
      { id: orderId, status: statusId },
    ];

    const errors: string[] = [];
    for (const payload of payloads) {
      try {
        await this.send<unknown>('orders.setStatus', payload);
        return;
      } catch (err) {
        errors.push((err as Error).message);
      }
    }

    throw new BluesalesError(`orders.setStatus failed: ${errors.join(' | ')}`);
  }
}
