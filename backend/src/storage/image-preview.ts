import sharp from 'sharp';
import { Worker } from 'worker_threads';
import { join } from 'path';
import { readFile } from 'fs/promises';

export const PREVIEW_SIZES = { thumbnail: 600, preview: 1800 };

export function imagePreviewKeys(objectKey: string) {
  return {
    thumbnailKey: `${objectKey}.thumbnail-v1.webp`,
    previewKey: `${objectKey}.preview-v1.webp`,
  };
}

export function isPreviewCandidate(filename: string, mimeType?: string | null) {
  if (/\.(pdf|dng|svg)$/i.test(filename) || /^(application\/pdf|image\/(svg\+xml|dng|x-adobe-dng))$/i.test(mimeType ?? '')) return false;
  return mimeType?.startsWith('image/') || /\.(jpe?g|png|webp|gif|tiff?|avif|heic|heif|bmp)$/i.test(filename);
}

/** Only small encoded outputs enter JS memory; the source can stay on disk. */
export async function generateImagePreviews(input: string | Buffer) {
  const options = { limitInputPixels: 100_000_000 };
  const metadata = await sharp(input, options).metadata();
  if (!['jpeg', 'png', 'webp', 'gif', 'tiff', 'heif'].includes(metadata.format ?? '')) {
    throw new Error('Формат не поддерживает растровое превью');
  }
  // The prebuilt libvips supports AVIF but lacks an HEVC decoder for iPhone HEIC.
  // Decode its first image in the worker, then let sharp resize raw pixels.
  let raw: { width: number; height: number; data: Uint8ClampedArray } | null = null;
  if (metadata.format === 'heif' && metadata.compression === 'hevc') {
    const decode = require('heic-decode');
    const images = await decode.all({ buffer: typeof input === 'string' ? await readFile(input) : input });
    try {
      if (!images[0] || images[0].width * images[0].height > options.limitInputPixels) {
        throw new Error('HEIC превышает допустимое число пикселей');
      }
      raw = await images[0].decode();
    } finally {
      images.dispose();
    }
  }
  const render = (size: number, quality: number) => (raw
    ? sharp(Buffer.from(raw.data.buffer, raw.data.byteOffset, raw.data.byteLength), {
      raw: { width: raw.width, height: raw.height, channels: 4 },
    })
    : sharp(input, options).rotate())
    .resize({ width: size, height: size, fit: 'inside', withoutEnlargement: true })
    .webp({ quality, effort: 3 })
    .timeout({ seconds: 30 })
    .toBuffer();
  // Do not decode two huge images in parallel.
  const thumbnail = await render(PREVIEW_SIZES.thumbnail, 75);
  const preview = await render(PREVIEW_SIZES.preview, 82);
  return { thumbnail, preview };
}

/** Isolate HEIC's synchronous decoder and release its memory after every job. */
export function renderImagePreviews(input: string | Buffer): Promise<{ thumbnail: Buffer; preview: Buffer }> {
  return new Promise((resolve, reject) => {
    let responded = false;
    const worker = new Worker(join(__dirname, 'image-preview.worker.js'), {
      workerData: { input },
      resourceLimits: { maxOldGenerationSizeMb: 128 },
    });
    const timeout = setTimeout(() => {
      void worker.terminate();
      reject(new Error('Превью превысило время обработки'));
    }, 60_000);
    worker.once('message', (message) => {
      responded = true;
      clearTimeout(timeout);
      if (message.error) reject(new Error(message.error));
      else resolve({ thumbnail: Buffer.from(message.thumbnail), preview: Buffer.from(message.preview) });
    });
    worker.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    worker.once('exit', (code) => {
      clearTimeout(timeout);
      if (!responded) reject(new Error(`Обработка превью завершилась без результата (код ${code})`));
    });
  });
}

/** Shared by uploads and backfill: at most one image job per backend process. */
export class ImagePreviewQueue {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(job: () => Promise<T>): Promise<T> {
    const result = this.tail.then(job);
    this.tail = result.catch(() => undefined);
    return result;
  }
}
