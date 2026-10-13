import sharp from 'sharp';
import { Worker } from 'worker_threads';
import { join } from 'path';
import { readFile } from 'fs/promises';
import { imageJobConfiguration } from './image-job.config';

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
      responded = true;
      void worker.terminate().then(() => reject(new Error('Превью превысило время обработки')), reject);
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

/** Shared by uploads, backfill and production: one concurrency limit per process. */
export class ImagePreviewQueue {
  private active = 0;
  private readonly waiting: Array<{ start: () => void; kind: 'preview' | 'production'; priority: boolean }> = [];
  private readonly measurements: Array<{ kind: 'preview' | 'production'; durationMs: number; completedAt: number; success: boolean }> = [];
  private readonly counts = {
    preview: { waiting: 0, running: 0 },
    production: { waiting: 0, running: 0 },
  };

  constructor(private readonly concurrency = imageJobConfiguration().total,
    private readonly limits = { preview: concurrency, production: concurrency }) {
    if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error('Invalid image concurrency');
    if (Object.values(limits).some((limit) => !Number.isInteger(limit) || limit < 1)) throw new Error('Invalid image kind concurrency');
  }

  snapshot() {
    return { preview: { ...this.counts.preview }, production: { ...this.counts.production } };
  }

  recentMeasurements() {
    this.pruneMeasurements();
    return this.measurements.map((measurement) => ({ ...measurement }));
  }

  private pruneMeasurements() {
    const cutoff = Date.now() - 3_600_000;
    while (this.measurements.length && (this.measurements[0].completedAt < cutoff || this.measurements.length > 10_000)) this.measurements.shift();
  }

  run<T>(job: () => Promise<T>, kind: 'preview' | 'production' = 'preview', priority = false,
    measureResult: (result: T) => boolean | null = () => true): Promise<T> {
    const counts = this.counts[kind];
    counts.waiting++;
    return new Promise<T>((resolve, reject) => {
      this.waiting.push({ kind, priority, start: () => {
        counts.waiting--;
        counts.running++;
        this.active++;
        const startedAt = Date.now();
        let success: boolean | null = false;
        void (async () => {
          try { const result = await job(); success = measureResult(result); resolve(result); }
          catch (error) { reject(error); }
          finally {
            if (success !== null) this.measurements.push({ kind, durationMs: Date.now() - startedAt, completedAt: Date.now(), success });
            this.pruneMeasurements();
            counts.running--;
            this.active--;
            this.drain();
          }
        })();
      } });
      this.drain();
    });
  }

  private drain() {
    while (this.active < this.concurrency && this.waiting.length) {
      const eligible = (entry: typeof this.waiting[number]) => this.counts[entry.kind].running < this.limits[entry.kind];
      let index = this.waiting.findIndex((entry) => entry.priority && eligible(entry));
      if (index < 0) index = this.waiting.findIndex(eligible);
      if (index < 0) return;
      this.waiting.splice(index, 1)[0].start();
    }
  }
}
