import {
  CallHandler,
  ExecutionContext,
  Injectable,
  Logger,
  NestInterceptor,
  PayloadTooLargeException,
} from '@nestjs/common';
import { Request } from 'express';
import { Observable, catchError, throwError } from 'rxjs';
import { MAX_UPLOAD_MB, formatBytes } from './upload.config';

/**
 * Multer падает ДО входа в обработчик, поэтому его ошибки нельзя поймать
 * try/catch внутри контроллера. Этот перехватчик ставится перед
 * FileInterceptor, видит его ошибки, пишет их в лог с размером запроса и
 * подменяет технические тексты («File too large») на понятные пользователю.
 */
@Injectable()
export class UploadErrorInterceptor implements NestInterceptor {
  private readonly logger = new Logger('Upload');

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = context.switchToHttp().getRequest<Request>();
    const declared = Number(req.headers['content-length']) || 0;

    return next.handle().pipe(
      catchError((error: unknown) => {
        if (error instanceof PayloadTooLargeException) {
          this.logger.warn(
            `Загрузка отклонена: превышен лимит ${MAX_UPLOAD_MB} МБ ` +
              `(тело запроса ${formatBytes(declared)})`,
          );
          return throwError(
            () =>
              new PayloadTooLargeException(
                `Файл больше ${MAX_UPLOAD_MB} МБ — уменьшите размер и попробуйте снова`,
              ),
          );
        }
        return throwError(() => error);
      }),
    );
  }
}
