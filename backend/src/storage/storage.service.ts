import { Injectable, OnModuleInit, Logger } from '@nestjs/common';
import { Client as MinioClient } from 'minio';
import { randomUUID } from 'crypto';

@Injectable()
export class StorageService implements OnModuleInit {
  private readonly logger = new Logger(StorageService.name);
  private internalClient: MinioClient;
  private publicClient: MinioClient;
  private bucket: string;

  constructor() {
    const accessKey = process.env.MINIO_ACCESS_KEY || 'minioadmin';
    const secretKey = process.env.MINIO_SECRET_KEY || 'minioadmin';
    this.bucket = process.env.MINIO_BUCKET || 'metalica';

    // Pin the region so the client never performs a getBucketRegion network
    // lookup. Without this, presignedGetObject on the public client tries to
    // reach its (browser-facing) endpoint from inside the container, which is
    // unreachable and fails with ECONNREFUSED.
    const region = process.env.MINIO_REGION || 'us-east-1';

    // Internal client: used inside the docker network for uploads/admin.
    this.internalClient = new MinioClient({
      endPoint: process.env.MINIO_ENDPOINT || 'minio',
      port: Number(process.env.MINIO_PORT) || 9000,
      useSSL: (process.env.MINIO_USE_SSL || 'false') === 'true',
      region,
      accessKey,
      secretKey,
    });

    // Public client: used only to compute presigned GET URLs that the
    // browser can reach. Its endpoint must be browser-reachable, because the
    // host is part of the signed request.
    this.publicClient = new MinioClient({
      endPoint: process.env.MINIO_PUBLIC_ENDPOINT || 'localhost',
      port: Number(process.env.MINIO_PUBLIC_PORT) || 9000,
      useSSL: (process.env.MINIO_PUBLIC_USE_SSL || 'false') === 'true',
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

  async upload(file: { buffer: Buffer; originalname: string; mimetype: string }) {
    const ext = file.originalname.includes('.')
      ? file.originalname.substring(file.originalname.lastIndexOf('.'))
      : '';
    const key = `${new Date().toISOString().slice(0, 10)}/${randomUUID()}${ext}`;

    await this.internalClient.putObject(
      this.bucket,
      key,
      file.buffer,
      file.buffer.length,
      { 'Content-Type': file.mimetype || 'application/octet-stream' },
    );

    return { key, filename: file.originalname, mimeType: file.mimetype };
  }

  async getUrl(objectKey: string, expirySeconds = 60 * 60 * 24): Promise<string> {
    return this.publicClient.presignedGetObject(this.bucket, objectKey, expirySeconds);
  }
}
