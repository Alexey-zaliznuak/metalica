import {
  Controller,
  Logger,
  Post,
  UploadedFile,
  UseGuards,
  UseInterceptors,
  BadRequestException,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { diskStorage } from 'multer';
import { tmpdir } from 'os';
import { unlink } from 'fs/promises';
import { StorageService } from './storage.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { UploadErrorInterceptor } from './upload-error.interceptor';
import { MAX_UPLOAD_BYTES, formatBytes } from './upload.config';

@UseGuards(JwtAuthGuard)
@Controller('uploads')
export class StorageController {
  private readonly logger = new Logger('Upload');

  constructor(private storage: StorageService) {}

  /**
   * Файл пишется во временный файл на диске, а не в память: при лимите в
   * сотни мегабайт memoryStorage держал бы весь файл в RSS процесса и пара
   * параллельных загрузок роняла бы контейнер по OOM.
   */
  @Post()
  @UseInterceptors(
    UploadErrorInterceptor,
    FileInterceptor('file', {
      storage: diskStorage({ destination: tmpdir() }),
      limits: { fileSize: MAX_UPLOAD_BYTES },
    }),
  )
  async upload(@UploadedFile() file: Express.Multer.File) {
    if (!file) {
      this.logger.warn('Загрузка без файла: в форме нет поля "file"');
      throw new BadRequestException('Файл не передан');
    }

    this.logger.log(
      `Принят "${file.originalname}" (${formatBytes(file.size)}, ${file.mimetype || 'без mime'})`,
    );

    try {
      const result = await this.storage.upload(file);
      const url = await this.storage.getUrl(result.key);
      return { ...result, url };
    } finally {
      if (file.path) {
        await unlink(file.path).catch((e: Error) =>
          this.logger.warn(
            `Не удалось удалить временный файл ${file.path}: ${e.message}`,
          ),
        );
      }
    }
  }
}
