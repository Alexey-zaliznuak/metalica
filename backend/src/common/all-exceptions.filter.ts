import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { Prisma } from '@prisma/client';

interface AuthedRequest extends Request {
  user?: { id?: number; username?: string };
}

/**
 * Глобальный фильтр: логирует ЛЮБУЮ ошибку, дошедшую до фреймворка, вместе с
 * методом, URL, статусом, пользователем и стеком. Раньше 500-ки (напр.
 * «column does not exist» от Prisma) уходили в ответ молча — теперь они видны
 * в логах контейнера.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('Exception');

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const req = ctx.getRequest<AuthedRequest>();

    const { status, body } = this.resolve(exception);

    const who = req.user?.username ? `user=${req.user.username}` : 'anon';
    const message =
      exception instanceof Error ? exception.message : String(exception);
    const context = `${req.method} ${req.originalUrl} -> ${status} (${who})`;

    if (status >= HttpStatus.INTERNAL_SERVER_ERROR) {
      // Серверные ошибки — со стеком, это то, что нужно чинить.
      this.logger.error(
        `${context}: ${message}`,
        exception instanceof Error ? exception.stack : undefined,
      );
    } else {
      // Клиентские ошибки (4xx) — коротко, без стека, чтобы не шуметь.
      this.logger.warn(`${context}: ${message}`);
    }

    res.status(status).json(body);
  }

  /**
   * Вычисляет HTTP-статус и тело ответа, сохраняя прежний формат для клиента.
   */
  private resolve(exception: unknown): {
    status: number;
    body: Record<string, unknown>;
  } {
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const response = exception.getResponse();
      const body =
        typeof response === 'string'
          ? { statusCode: status, message: response }
          : (response as Record<string, unknown>);
      return { status, body };
    }

    // Известные ошибки Prisma — отдаём 400/409 с кодом, но подробности только в лог.
    if (exception instanceof Prisma.PrismaClientKnownRequestError) {
      const status =
        exception.code === 'P2002'
          ? HttpStatus.CONFLICT
          : HttpStatus.BAD_REQUEST;
      return {
        status,
        body: {
          statusCode: status,
          message: 'Ошибка запроса к базе данных',
          code: exception.code,
        },
      };
    }

    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      body: {
        statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
        message: 'Внутренняя ошибка сервера',
      },
    };
  }
}
