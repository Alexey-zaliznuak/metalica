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
/** Сетевая ошибка соединения с BlueSales — транзиентная (можно повторить). */
export class BluesalesConnectionError extends BluesalesHttpError {}
/** Таймаут HTTP-запроса к BlueSales — транзиентная (можно повторить). */
export class BluesalesTimeoutError extends BluesalesHttpError {}
/** Исчерпан лимит ожидания org-lock/сессии BlueSales — транзиентная. */
export class BluesalesBusyError extends BluesalesError {}

/**
 * Приоритет запроса в очереди к BlueSales.
 *  - interactive — действия пользователя (смена статуса и т.п.), обгоняют синк;
 *  - background  — фоновый синк (refresh-loop'ы, полный синк).
 */
export type BsRequestPriority = 'interactive' | 'background';

interface BsQueueItem {
  run: () => Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  priority: BsRequestPriority;
}

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

export interface BsTag {
  id?: number;
  name?: string;
  color?: string | null;
  colour?: string | null;
  hexColor?: string | null;
  backgroundColor?: string | null;
  backColor?: string | null;
  [key: string]: unknown;
}

export interface BsCustomer {
  id?: number;
  fullName?: string;
  vk?: BsVkInfo | null;
  crmStatus?: BsCrmStatus | null;
  // «Источник» клиента в BlueSales (напр. "avito").
  source?: { id?: number; name?: string } | null;
  salesChannel?: { id?: number; code?: number; name?: string } | null;
  // Менеджер клиента в BlueSales — источник «менеджера ведения».
  manager?: BsManager | null;
  // «Отметки» клиента в BlueSales — простая строка.
  shortNotes?: string | null;
  // «Теги» клиента в BlueSales — список объектов { id, name, color }.
  tags?: BsTag[] | null;
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

const MAX_PAGE_SIZE = 500;

@Injectable()
export class BluesalesApiService {
  private readonly logger = new Logger(BluesalesApiService.name);
  private readonly login: string;
  private readonly passwordHash: string;
  private pausedUntilTs: number | null = null;

  // Приоритетная очередь сериализации запросов (single-session на логин).
  // Интерактивные запросы (действия пользователя) обгоняют фоновый синк,
  // чтобы залипший фоновый запрос не блокировал пользовательский API на часы.
  private readonly queue: BsQueueItem[] = [];
  private processing = false;

  // ─── Настройки таймаутов/ретраев (из env) ─────────────────────────────────
  /** Таймаут одного HTTP-запроса к BlueSales (мс). */
  private readonly requestTimeoutMs: number;
  /** Максимальное суммарное окно ретраев одного запроса (мс) — потолок ожидания. */
  private readonly maxRetryWindowMs: number;
  /** Лимит ретраев на ошибку «уже выполняется другое обращение в организации». */
  private readonly maxBusyRetries: number;
  /** Лимит ретраев на ошибку «другой пользователь онлайн под логином». */
  private readonly maxSessionRetries: number;
  /** Сколько раз повторно ставить интерактивный запрос в очередь при транзиентной ошибке. */
  private readonly interactiveMaxRequeues: number;
  /** Пауза перед повторной постановкой интерактивного запроса в очередь (мс). */
  private readonly interactiveRequeueDelayMs: number;

  constructor(private readonly config: ConfigService) {
    this.login = this.config.get<string>('BLUESALES_LOGIN', '');
    const password = this.config.get<string>('BLUESALES_PASSWORD', '');
    this.passwordHash = password ? this.hashPassword(password) : '';

    this.requestTimeoutMs = this.envInt('BLUESALES_REQUEST_TIMEOUT_MS', 30_000);
    this.maxRetryWindowMs = this.envInt('BLUESALES_MAX_RETRY_MS', 300_000);
    this.maxBusyRetries = this.envInt('BLUESALES_BUSY_MAX_RETRIES', 20);
    this.maxSessionRetries = this.envInt('BLUESALES_SESSION_MAX_RETRIES', 10);
    this.interactiveMaxRequeues = this.envInt('BLUESALES_INTERACTIVE_MAX_REQUEUES', 3);
    this.interactiveRequeueDelayMs = this.envInt('BLUESALES_INTERACTIVE_REQUEUE_DELAY_MS', 1000);
  }

  private envInt(key: string, def: number): number {
    const raw = this.config.get<string>(key);
    const n = raw != null && raw !== '' ? Number(raw) : NaN;
    return Number.isFinite(n) && n > 0 ? n : def;
  }

  get isConfigured(): boolean {
    return Boolean(this.login && this.passwordHash);
  }

  private hashPassword(password: string): string {
    return createHash('md5').update(password, 'utf-8').digest('hex').toUpperCase();
  }

  /**
   * Ставит задачу в очередь. Интерактивные запросы встают перед фоновыми,
   * но выполняется по-прежнему строго по одному запросу за раз (single-session).
   */
  private schedule<T>(task: () => Promise<T>, priority: BsRequestPriority): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.queue.push({
        run: task as () => Promise<unknown>,
        resolve: resolve as (value: unknown) => void,
        reject,
        priority,
      });
      void this.processQueue();
    });
  }

  /** Достаёт следующий элемент: сначала интерактивные (FIFO внутри приоритета). */
  private takeNext(): BsQueueItem | undefined {
    const idx = this.queue.findIndex((item) => item.priority === 'interactive');
    const target = idx === -1 ? 0 : idx;
    return this.queue.splice(target, 1)[0];
  }

  private async processQueue(): Promise<void> {
    if (this.processing) return;
    this.processing = true;
    try {
      while (this.queue.length > 0) {
        const item = this.takeNext();
        if (!item) break;
        try {
          item.resolve(await item.run());
        } catch (err) {
          item.reject(err);
        }
      }
    } finally {
      this.processing = false;
    }
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

  private describeRequest(method: string, data: unknown): string {
    if (method === 'orders.updateMany' || method === 'orders.setStatus') {
      return JSON.stringify(data);
    }
    if (method === 'orders.get' && data && typeof data === 'object') {
      const filters = data as {
        ids?: unknown;
        internalNumbers?: unknown;
        pageSize?: unknown;
        startRowNumber?: unknown;
      };
      return JSON.stringify({
        ids: filters.ids,
        internalNumbers: filters.internalNumbers,
        pageSize: filters.pageSize,
        startRowNumber: filters.startRowNumber,
      });
    }
    return data == null ? 'null' : `[${typeof data} payload скрыт]`;
  }

  private truncateLogValue(value: string, maxLength = 1000): string {
    return value.length <= maxLength ? value : `${value.slice(0, maxLength)}…`;
  }

  private async sendRaw<T>(
    method: string,
    data?: unknown,
    attempt = 1,
    deadline = 0,
  ): Promise<T> {
    if (!this.isConfigured) {
      throw new BluesalesAuthError('BlueSales credentials are not configured');
    }

    // Общий потолок ожидания на один логический запрос (со всеми ретраями).
    // Фиксируется на первой попытке и защищает от многочасового залипания.
    if (deadline === 0) {
      deadline = Date.now() + this.maxRetryWindowMs;
    }

    const url = new URL(BASE_URL);
    url.searchParams.set('login', this.login);
    url.searchParams.set('password', this.passwordHash);
    url.searchParams.set('command', method);

    // Таймаут на HTTP-запрос: без него зависший fetch держал бы очередь вечно.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    let text: string;
    let responseStatus = 0;
    const startedAt = Date.now();
    const requestDescription = this.describeRequest(method, data);
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data ?? null),
        signal: controller.signal,
      });
      responseStatus = response.status;
      if (response.status === 404) {
        throw new BluesalesHttpError(`Method ${method} not found!`);
      }
      text = await response.text();
    } catch (err) {
      if (err instanceof BluesalesError) {
        throw err;
      }
      if (controller.signal.aborted) {
        this.logger.error(
          `BlueSales ${method}: timeout; attempt=${attempt}; ` +
            `request=${requestDescription}; elapsedMs=${Date.now() - startedAt}`,
        );
        throw new BluesalesTimeoutError(
          `BlueSales API timeout после ${this.requestTimeoutMs} мс (метод ${method})`,
        );
      }
      this.logger.error(
        `BlueSales ${method}: connection error; attempt=${attempt}; ` +
          `request=${requestDescription}; error=${(err as Error).message}`,
      );
      throw new BluesalesConnectionError(
        `Error connecting to bluesales.ru API: ${(err as Error).message}`,
      );
    } finally {
      clearTimeout(timer);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      this.logger.error(
        `BlueSales ${method}: invalid JSON; status=${responseStatus}; attempt=${attempt}; ` +
          `request=${requestDescription}; response=${this.truncateLogValue(text)}`,
      );
      throw new BluesalesError(`Invalid JSON from BlueSales: ${text.slice(0, 200)}`);
    }

    const responseError =
      parsed && typeof parsed === 'object'
        ? ((parsed as { error?: unknown; errorMessage?: unknown }).error ??
          (parsed as { errorMessage?: unknown }).errorMessage)
        : null;
    if (
      responseStatus < 200 ||
      responseStatus >= 300 ||
      (parsed &&
        typeof parsed === 'object' &&
        'isValid' in parsed &&
        (parsed as { isValid?: boolean }).isValid === false) ||
      (typeof responseError === 'string' && responseError.trim().length > 0)
    ) {
      const errorText =
        typeof responseError === 'string' && responseError.trim()
          ? responseError
          : `HTTP ${responseStatus}`;
      this.logger.error(
        `BlueSales ${method}: API error; status=${responseStatus}; attempt=${attempt}; ` +
          `request=${requestDescription}; response=${this.truncateLogValue(text)}`,
      );

      // Транзиентная ошибка = временная конкуренция за org-lock/сессию BlueSales,
      // которую имеет смысл повторить (в т.ч. вернув запрос в очередь).
      let transient = false;

      if (errorText === 'Неправильный логин или пароль.') {
        throw new BluesalesAuthError(errorText);
      }

      // Другая сессия онлайн под логином — ждём countdown и повторяем,
      // но с лимитом попыток и общим потолком ожидания (иначе бесконечный цикл).
      if (errorText.includes('Другой пользователь находится онлайн под логином')) {
        const delay = this.parseCountdown(errorText);
        if (delay !== null) {
          const waitMs = (delay + 1) * 1000;
          if (attempt < this.maxSessionRetries && Date.now() + waitMs <= deadline) {
            this.logger.warn(
              `BlueSales: другая сессия онлайн, ждём ${delay + 1}s и повторяем ` +
                `(попытка ${attempt}/${this.maxSessionRetries})`,
            );
            await this.sleep(waitMs);
            return this.sendRaw<T>(method, data, attempt + 1, deadline);
          }
          this.logger.error(
            `BlueSales: другая сессия онлайн — исчерпан лимит ожидания ` +
              `(попытка ${attempt}/${this.maxSessionRetries}), прекращаем повторы`,
          );
        }
        transient = true;
      }

      // Другой пользователь организации уже выполняет запрос — ждём и повторяем,
      // с лимитом попыток и общим потолком ожидания.
      if (errorText.includes('Уже выполняется одно или несколько других обращений к API')) {
        // Первые попытки — быстро (до 30с), затем фиксированные 30с паузы.
        const delaySec = Math.min(attempt * 3, 30);
        const waitMs = delaySec * 1000;
        if (attempt <= this.maxBusyRetries && Date.now() + waitMs <= deadline) {
          this.logger.warn(
            `BlueSales: параллельный запрос в организации, ждём ${delaySec}s ` +
              `(попытка ${attempt}/${this.maxBusyRetries})`,
          );
          await this.sleep(waitMs);
          return this.sendRaw<T>(method, data, attempt + 1, deadline);
        }
        this.logger.error(
          `BlueSales: параллельный запрос — исчерпан лимит ожидания ` +
            `(попытка ${attempt}/${this.maxBusyRetries}), прекращаем повторы`,
        );
        transient = true;
      }

      throw transient
        ? new BluesalesBusyError(`${method}: ${errorText}`)
        : new BluesalesError(`${method}: ${errorText}`);
    }

    return parsed as T;
  }

  /** Публичный отправитель — все вызовы проходят через приоритетную очередь. */
  send<T>(
    method: string,
    data?: unknown,
    priority: BsRequestPriority = 'background',
  ): Promise<T> {
    const dispatch = () =>
      this.schedule(async () => {
        await this.waitIfPaused();
        return this.sendRaw<T>(method, data);
      }, priority);

    // Интерактивные запросы не теряем: при транзиентной ошибке возвращаем их
    // обратно в очередь (с приоритетом) до исчерпания лимита повторов.
    if (priority !== 'interactive') {
      return dispatch();
    }
    return this.dispatchWithRequeue(dispatch, method);
  }

  /**
   * Повторно ставит интерактивный запрос в очередь при транзиентной ошибке.
   * Каждая попытка — новый элемент очереди, поэтому он снова обгоняет фоновый синк.
   */
  private async dispatchWithRequeue<T>(
    dispatch: () => Promise<T>,
    method: string,
  ): Promise<T> {
    let attempt = 0;
    for (;;) {
      try {
        return await dispatch();
      } catch (err) {
        attempt++;
        if (!this.isTransientError(err) || attempt > this.interactiveMaxRequeues) {
          throw err;
        }
        this.logger.warn(
          `BlueSales: интерактивный запрос ${method} вернулся в очередь после ` +
            `транзиентной ошибки (повтор ${attempt}/${this.interactiveMaxRequeues}): ` +
            `${(err as Error).message}`,
        );
        await this.sleep(this.interactiveRequeueDelayMs);
      }
    }
  }

  /** Транзиентные ошибки — временные, их имеет смысл повторить. */
  private isTransientError(err: unknown): boolean {
    return (
      err instanceof BluesalesBusyError ||
      err instanceof BluesalesTimeoutError ||
      err instanceof BluesalesConnectionError
    );
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
  async getOrdersByIds(
    ids: number[],
    priority: BsRequestPriority = 'background',
  ): Promise<BsOrder[]> {
    if (ids.length === 0) return [];
    const result = await this.send<GetOrdersResponse>(
      'orders.get',
      {
        dateFrom: null,
        dateTill: null,
        orderStatuses: [],
        customerId: null,
        ids,
        internalNumbers: null,
        pageSize: ids.length,
        startRowNumber: 0,
      },
      priority,
    );
    return result.orders ?? [];
  }

  /**
   * Постранично получить клиентов (лидов) BlueSales.
   *
   * Фильтрация по датам — только на уровне дня (BS оперирует датами без времени):
   *  - firstContactFrom/firstContactTo — по дате первого контакта (когда лид создан);
   *  - lastContactFrom/lastContactTo   — по дате последнего контакта (активность).
   * Правая граница трактуется BS как «до начала дня», поэтому +1 день включительно.
   */
  async getCustomers(
    params: {
      firstContactFrom?: Date | null;
      firstContactTo?: Date | null;
      lastContactFrom?: Date | null;
      lastContactTo?: Date | null;
      ids?: number[] | null;
    } = {},
    priority: BsRequestPriority = 'background',
  ): Promise<BsCustomer[]> {
    const dayAfter = (date: Date) => this.formatDate(new Date(date.getTime() + 24 * 60 * 60 * 1000));

    const baseData = {
      firstContactDateFrom: params.firstContactFrom ? this.formatDate(params.firstContactFrom) : null,
      firstContactDateTill: params.firstContactTo ? dayAfter(params.firstContactTo) : null,
      nextContactDateFrom: null,
      nextContactDateTill: null,
      lastContactDateFrom: params.lastContactFrom ? this.formatDate(params.lastContactFrom) : null,
      lastContactDateTill: params.lastContactTo ? dayAfter(params.lastContactTo) : null,
      ids: params.ids ?? null,
      vkIds: null,
      tags: [] as unknown[],
      managers: [] as unknown[],
      sources: null,
      phone: null,
    };

    const first = await this.send<GetCustomersResponse>(
      'customers.get',
      { ...baseData, pageSize: 1, startRowNumber: 0 },
      priority,
    );
    const total = (first.notReturnedCount ?? 0) + (first.count ?? 0);
    if (total === 0) {
      return [];
    }

    const items: BsCustomer[] = [];
    let offset = 0;
    while (items.length < total) {
      const page = await this.send<GetCustomersResponse>(
        'customers.get',
        { ...baseData, pageSize: MAX_PAGE_SIZE, startRowNumber: offset },
        priority,
      );
      items.push(...(page.customers ?? []));
      offset += MAX_PAGE_SIZE;
      if (!page.customers || page.customers.length === 0) {
        break;
      }
    }
    return items;
  }

  /** Получить конкретных клиентов по списку BS-идентификаторов (до 500 штук). */
  async getCustomersByIds(
    ids: number[],
    priority: BsRequestPriority = 'background',
  ): Promise<BsCustomer[]> {
    if (ids.length === 0) return [];
    const result = await this.send<GetCustomersResponse>(
      'customers.get',
      {
        firstContactDateFrom: null,
        firstContactDateTill: null,
        nextContactDateFrom: null,
        nextContactDateTill: null,
        lastContactDateFrom: null,
        lastContactDateTill: null,
        ids,
        vkIds: null,
        tags: [],
        managers: [],
        sources: null,
        phone: null,
        pageSize: ids.length,
        startRowNumber: 0,
      },
      priority,
    );
    return result.customers ?? [];
  }

  /** Постранично получить все заказы за период [dateFrom, dateTo]. */
  async getOrders(
    dateFrom?: Date,
    dateTo?: Date,
    priority: BsRequestPriority = 'background',
  ): Promise<BsOrder[]> {
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

    const first = await this.send<GetOrdersResponse>(
      'orders.get',
      { ...baseData, pageSize: 1, startRowNumber: 0 },
      priority,
    );
    const total = (first.notReturnedCount ?? 0) + (first.count ?? 0);
    if (total === 0) {
      return [];
    }

    const items: BsOrder[] = [];
    let offset = 0;
    while (items.length < total) {
      const page = await this.send<GetOrdersResponse>(
        'orders.get',
        { ...baseData, pageSize: MAX_PAGE_SIZE, startRowNumber: offset },
        priority,
      );
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
   * Для пользовательских статусов используем документированный orders.updateMany:
   * orders.setStatus принимает старый системный код (0–5), а не id пользовательского
   * статуса, поэтому мог вернуть успех, не применив нужный статус.
   * Приоритет по умолчанию — interactive: это действие пользователя.
   */
  async setOrderStatus(
    orderId: number,
    statusId: number,
    priority: BsRequestPriority = 'interactive',
  ): Promise<void> {
    const payload = {
      ids: [orderId],
      orderStatus: { id: statusId },
    };
    const response = await this.send<unknown>('orders.updateMany', payload, priority);
    this.logger.log(
      `BlueSales orders.updateMany: статус отправлен; orderId=${orderId}; ` +
        `statusId=${statusId}; response=${this.truncateLogValue(JSON.stringify(response))}`,
    );
  }
}
