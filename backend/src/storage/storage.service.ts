import { Injectable, OnModuleInit, Logger } from '@nestjs/common';
import { Client as MinioClient } from 'minio';
import { randomUUID } from 'crypto';
import { createReadStream, createWriteStream } from 'fs';
import { pipeline } from 'stream/promises';
import { mkdtemp, unlink, rmdir, stat as fileStat } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { formatBytes } from './upload.config';
import { renderImagePreviews, imagePreviewKeys, ImagePreviewQueue, isPreviewCandidate } from './image-preview';

export interface StoredImagePreviews {
  thumbnailKey: string | null;
  previewKey: string | null;
  previewStatus: 'pending' | 'ready' | 'unavailable';
}

export interface StoredFileMeta {
  size: number;
  mimeType: string | null;
  previews: StoredImagePreviews;
}

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
  private publicFilesVersion: string;
  private readonly previewQueue = new ImagePreviewQueue();

  constructor() {
    const accessKey = process.env.MINIO_ACCESS_KEY || 'minioadmin';
    const secretKey = process.env.MINIO_SECRET_KEY || 'minioadmin';
    this.bucket = process.env.MINIO_BUCKET || 'metalica';
    const appDomain = (process.env.APP_DOMAIN || 'metallity-crm.ru')
      .replace(/^https?:\/\//, '')
      .replace(/\/+$/, '');
    const appProtocol = (process.env.APP_PROTOCOL || 'https').replace(/:$/, '');
    this.publicFilesBaseUrl = `${appProtocol}://${appDomain}/files`;
    this.publicFilesVersion = process.env.FILES_URL_VERSION || '1';

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
    let previews: StoredImagePreviews = { thumbnailKey: null, previewKey: null, previewStatus: 'unavailable' };

    if (isPreviewCandidate(file.originalname, file.mimetype)) {
      // A failed preview must not prevent uploading the original.
      try {
        previews = await this.previewQueue.run(() => this.storePreviews(key, file.path ?? file.buffer!));
      } catch (error) {
        previews = { thumbnailKey: null, previewKey: null, previewStatus: 'pending' };
        this.logger.warn(`Превью "${key}" будет повторено в фоне: ${(error as Error).message}`);
      }
    }

    try {
      const body = file.path ? createReadStream(file.path) : file.buffer;
      if (!body) {
        throw new Error('нет ни path, ни buffer — загружать нечего');
      }

      await this.internalClient.putObject(this.bucket, key, body, size, {
        'Content-Type': file.mimetype || 'application/octet-stream',
        'X-Amz-Meta-Preview-Status': previews.previewStatus,
        ...(previews.thumbnailKey ? { 'X-Amz-Meta-Thumbnail-Key': previews.thumbnailKey } : {}),
        ...(previews.previewKey ? { 'X-Amz-Meta-Preview-Key': previews.previewKey } : {}),
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
      await this.removeObjects([key]);
      throw e;
    }

    return { key, filename: file.originalname, mimeType: file.mimetype };
  }

  /**
   * Метаданные объекта в бакете. Источник правды по размеру и типу файла:
   * значения от клиента для этого не годятся. Возвращает null, если объекта
   * нет или хранилище недоступно — вызывающий код должен уметь жить без них.
   */
  async stat(
    objectKey: string,
  ): Promise<StoredFileMeta | null> {
    try {
      const stat = await this.internalClient.statObject(this.bucket, objectKey);
      return {
        size: stat.size,
        mimeType: (stat.metaData?.['content-type'] as string) || null,
        previews: {
          thumbnailKey: (stat.metaData?.['thumbnail-key'] as string) || null,
          previewKey: (stat.metaData?.['preview-key'] as string) || null,
          previewStatus: stat.metaData?.['preview-status'] === 'ready' ? 'ready'
            : stat.metaData?.['preview-status'] === 'unavailable' ? 'unavailable' : 'pending',
        },
      };
    } catch (e) {
      this.logger.warn(
        `Не удалось получить метаданные "${objectKey}" из "${this.bucket}": ${(e as Error).message}`,
      );
      return null;
    }
  }

  async getUrl(objectKey: string): Promise<string> {
    const encodedKey = objectKey.split('/').map(encodeURIComponent).join('/');
    return `${this.publicFilesBaseUrl}/${encodedKey}?v=${encodeURIComponent(this.publicFilesVersion)}`;
  }

  /** Read the stored original through the internal client, without a public URL or a RAM copy. */
  async downloadToFile(objectKey: string, destination: string): Promise<void> {
    const source = await this.internalClient.getObject(this.bucket, objectKey);
    await pipeline(source, createWriteStream(destination));
  }

  async getStream(objectKey: string) {
    return this.internalClient.getObject(this.bucket, objectKey);
  }

  /** A prepared production file is already encoded; stream it without previews. */
  async uploadPreparedFile(objectKey: string, path: string): Promise<number> {
    const { size } = await fileStat(path);
    await this.internalClient.putObject(this.bucket, objectKey, createReadStream(path), size, { 'Content-Type': 'image/png' });
    return size;
  }

  /** Exact-key deletion throws so the durable cleanup queue can retry failures. */
  async removeStoredObject(objectKey: string): Promise<void> {
    await this.internalClient.removeObject(this.bucket, objectKey);
  }

  runImageJob<T>(job: () => Promise<T>): Promise<T> {
    return this.previewQueue.run(job);
  }

  /** Used in the background for attachments uploaded before previews existed. */
  async ensureImagePreviews(objectKey: string): Promise<StoredImagePreviews> {
    return this.previewQueue.run(async () => {
      const stat = await this.stat(objectKey);
      if (!stat) throw new Error('Оригинал недоступен в хранилище');
      if (stat.previews.previewStatus !== 'pending') return stat.previews;
      if (!isPreviewCandidate(objectKey, stat.mimeType)) {
        return { thumbnailKey: null, previewKey: null, previewStatus: 'unavailable' };
      }
      const directory = await mkdtemp(join(tmpdir(), 'metalica-preview-'));
      const source = join(directory, 'original');
      try {
        await this.downloadToFile(objectKey, source);
        return await this.storePreviews(objectKey, source);
      } finally {
        await unlink(source).catch(() => undefined);
        await rmdir(directory).catch(() => undefined);
      }
    });
  }

  private async storePreviews(objectKey: string, input: string | Buffer): Promise<StoredImagePreviews> {
    let images: Awaited<ReturnType<typeof renderImagePreviews>>;
    try {
      images = await renderImagePreviews(input);
    } catch (error) {
      this.logger.warn(`Нет превью для "${objectKey}": ${(error as Error).message}`);
      return { thumbnailKey: null, previewKey: null, previewStatus: 'unavailable' };
    }
    const keys = imagePreviewKeys(objectKey);
    try {
      await this.internalClient.putObject(this.bucket, keys.thumbnailKey, images.thumbnail, images.thumbnail.length, { 'Content-Type': 'image/webp' });
      await this.internalClient.putObject(this.bucket, keys.previewKey, images.preview, images.preview.length, { 'Content-Type': 'image/webp' });
    } catch (error) {
      await this.internalClient.removeObjects(this.bucket, Object.values(keys)).catch(() => undefined);
      throw error;
    }
    this.logger.log(`Превью "${objectKey}": ${formatBytes(images.thumbnail.length)} / ${formatBytes(images.preview.length)}`);
    return { ...keys, previewStatus: 'ready' };
  }

  /**
   * Удаление объектов из бакета. Ошибки только логируются: осиротевший файл в
   * хранилище безобиднее, чем упавшая операция, которая уже удалила строки в БД.
   */
  async removeObjects(objectKeys: string[]): Promise<void> {
    const keys = [...new Set(objectKeys.filter((key) => key.length > 0)
      .flatMap((key) => [key, ...Object.values(imagePreviewKeys(key))]))];
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
