import { Injectable, OnModuleInit, Logger } from '@nestjs/common';
import { Client as MinioClient } from 'minio';
import { randomUUID } from 'crypto';
import { createReadStream } from 'fs';
import { formatBytes } from './upload.config';

interface UploadedFile {
  originalname: string;
  mimetype: string;
  size?: number;
  path?: string;
  buffer?: Buffer;
}

@Injectable()
export class StorageService implements OnModuleInit {
  private readonly logger = new Logger(StorageService.name);
  private internalClient: MinioClient;
  private bucket: string;
  private publicFilesBaseUrl: string;

  constructor() {
    const accessKey = process.env.MINIO_ACCESS_KEY || 'minioadmin';
    const secretKey = process.env.MINIO_SECRET_KEY || 'minioadmin';
    this.bucket = process.env.MINIO_BUCKET || 'metalica';
    const appDomain = (process.env.APP_DOMAIN || 'metallity-crm.ru')
      .replace(/^https?:\/\//, '')
      .replace(/\/+$/, '');
    const appProtocol = (process.env.APP_PROTOCOL || 'https').replace(/:$/, '');
    this.publicFilesBaseUrl = `${appProtocol}://${appDomain}/files`;

    const region = process.env.MINIO_REGION || 'us-east-1';

    this.internalClient = new MinioClient({
      endPoint: process.env.MINIO_ENDPOINT || 'minio',
      port: Number(process.env.MINIO_PORT) || 9000,
      useSSL: (process.env.MINIO_USE_SSL || 'false') === 'true',
      region,
      accessKey,
      secretKey,
    });
  }

  async onModuleInit() {
    try {
      const exists = await this.internalClient.bucketExists(this.bucket);
      if (!exists) {
        await this.internalClient.makeBucket(this.bucket, '');
        this.logger.log(`Created bucket "${this.bucket}"`);
      }
    } catch (e) {
      this.logger.error(`MinIO init failed: ${(e as Error).message}`);
    }
  }

  /**
   * Кладёт файл в бакет. Приходит либо путь к временному файлу (обычная
   * загрузка через multer diskStorage — тогда содержимое стримится и не
   * попадает в память целиком), либо готовый буфер.
   */
  async upload(file: UploadedFile) {
    const ext = file.originalname.includes('.')
      ? file.originalname.substring(file.originalname.lastIndexOf('.'))
      : '';
    const key = `${new Date().toISOString().slice(0, 10)}/${randomUUID()}${ext}`;
    const size = file.size ?? file.buffer?.length ?? 0;
    const startedAt = Date.now();

    try {
      const body = file.path ? createReadStream(file.path) : file.buffer;
      if (!body) {
        throw new Error('нет ни path, ни buffer — загружать нечего');
      }

      await this.internalClient.putObject(this.bucket, key, body, size, {
        'Content-Type': file.mimetype || 'application/octet-stream',
      });

      this.logger.log(
        `Сохранён "${key}" (${formatBytes(size)}) за ${Date.now() - startedAt}ms`,
      );
    } catch (e) {
      this.logger.error(
        `Не удалось сохранить "${file.originalname}" (${formatBytes(size)}) ` +
          `в бакет "${this.bucket}" как "${key}": ${(e as Error).message}`,
        (e as Error).stack,
      );
      throw e;
    }

    return { key, filename: file.originalname, mimeType: file.mimetype };
  }

  async getUrl(objectKey: string): Promise<string> {
    const encodedKey = objectKey.split('/').map(encodeURIComponent).join('/');
    return `${this.publicFilesBaseUrl}/${encodedKey}`;
  }

  /**
   * Удаление объектов из бакета. Ошибки только логируются: осиротевший файл в
   * хранилище безобиднее, чем упавшая операция, которая уже удалила строки в БД.
   */
  async removeObjects(objectKeys: string[]): Promise<void> {
    const keys = [...new Set(objectKeys.filter((key) => key.length > 0))];
    if (keys.length === 0) return;
    try {
      await this.internalClient.removeObjects(this.bucket, keys);
    } catch (e) {
      this.logger.error(
        `Не удалось удалить ${keys.length} объект(ов) из "${this.bucket}": ${(e as Error).message}`,
      );
    }
  }
}
