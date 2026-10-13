export interface ImageJobConfiguration {
  total: number;
  preview: number;
  production: number;
}

function positiveInteger(name: string, fallback: number): number {
  const value = process.env[name];
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

// Read after ConfigModule has loaded .env, when services are constructed.
export function imageJobConfiguration(): ImageJobConfiguration {
  const total = positiveInteger('IMAGE_JOB_CONCURRENCY', 4);
  return {
    total,
    preview: Math.min(total, positiveInteger('IMAGE_PREVIEW_CONCURRENCY', total)),
    production: Math.min(total, positiveInteger('PRODUCTION_IMAGE_CONCURRENCY', total)),
  };
}
