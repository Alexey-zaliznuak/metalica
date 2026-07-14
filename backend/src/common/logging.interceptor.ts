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
        next: () => {
          const ms = Date.now() - startedAt;
          this.logger.log(
            `${req.method} ${req.originalUrl} ${res.statusCode} ${ms}ms (${who})`,
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
}
