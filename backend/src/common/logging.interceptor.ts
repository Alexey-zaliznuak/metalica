import {
  CallHandler,
  ExecutionContext,
  Injectable,
  Logger,
  NestInterceptor,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { Observable, tap } from 'rxjs';

interface AuthedRequest extends Request {
  user?: { id?: number; username?: string };
}

/**
 * Логирует каждый HTTP-запрос: метод, путь, статус ответа и длительность.
 * Ошибки здесь не проглатываются — их дожимает AllExceptionsFilter, а сюда
 * попадает только строка о неуспехе для полноты картины по времени ответа.
 */
@Injectable()
export class LoggingInterceptor implements NestInterceptor {
  private readonly logger = new Logger('HTTP');

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') {
      return next.handle();
    }

    const http = context.switchToHttp();
    const req = http.getRequest<AuthedRequest>();
    const res = http.getResponse<Response>();
    const startedAt = Date.now();
    const who = req.user?.username ? req.user.username : 'anon';

    return next.handle().pipe(
      tap({
        next: (payload) => {
          const ms = Date.now() - startedAt;
          const size = this.describePayload(payload);
          this.logger.log(
            `${req.method} ${req.originalUrl} ${res.statusCode} ${ms}ms (${who})${size}`,
          );
        },
        error: (err: unknown) => {
          const ms = Date.now() - startedAt;
          const message = err instanceof Error ? err.message : String(err);
          this.logger.warn(
            `${req.method} ${req.originalUrl} FAILED ${ms}ms (${who}): ${message}`,
          );
        },
      }),
    );
  }

  /**
   * Короткая сводка по телу ответа, чтобы из логов было видно, вернулось ли
   * что-то (пустой ответ или нет). Форматы: массив -> [n]; пагинация
   * { items, total } -> [items/total]; иначе ничего не добавляем.
   */
  private describePayload(payload: unknown): string {
    if (Array.isArray(payload)) {
      return ` [items=${payload.length}]`;
    }
    if (payload && typeof payload === 'object') {
      const obj = payload as Record<string, unknown>;
      if (Array.isArray(obj.items)) {
        const total = typeof obj.total === 'number' ? obj.total : obj.items.length;
        return ` [items=${obj.items.length}/${total}]`;
      }
    }
    return '';
  }
}
