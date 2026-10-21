import { createHash } from 'crypto';
import type { ProductionParameters } from './production-file-renderer';
import { isShownOnProductionImage, productionArticleText } from './production-image';

export type ProductionTrigger = 'attachment_added' | 'order_update' | 'background_scan' | 'status' | 'download' | 'expedite' | 'worker';
export type ProductionChange = { field: string; before: string | number | string[] | null; after: string | number | string[] | null };
const plain = (value?: string | null) => (value ?? '').replace(/[\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim();

/** Compare what is printed. BlueSales does not keep goodsPositions in a stable order. */
export function productionContent(parameters: ProductionParameters) {
  return {
    orderNumber: plain(parameters.orderNumber), photoNumber: parameters.photoNumber ?? null,
    articles: parameters.articles.filter(isShownOnProductionImage).map(productionArticleText).filter(Boolean).sort(),
    comment: plain(parameters.comment), deliveryService: plain(parameters.deliveryService),
  };
}

export function productionFingerprint(sourceKey: string, parameters: ProductionParameters, textSize: string) {
  return createHash('sha256').update(JSON.stringify({ renderer: 'numbered-png-v3-content-v1', sourceKey,
    parameters: productionContent(parameters), textSize })).digest('hex');
}

/** Rebuild the pre-normalization hash, including insertion order lost in JSONB. */
function legacyFingerprint(sourceKey: string, parameters: ProductionParameters, textSize: string) {
  const ordered = { orderNumber: parameters.orderNumber, photoNumber: parameters.photoNumber,
    articles: parameters.articles.map((item) => ({ article: item.article, name: item.name,
      quantity: item.quantity, size: item.size, comment: item.comment })),
    comment: parameters.comment, deliveryService: parameters.deliveryService };
  return createHash('sha256').update(JSON.stringify({ renderer: 'numbered-png-v3', sourceKey, parameters: ordered, textSize })).digest('hex');
}

type Version = { sourceKey: string; parameters: unknown; textSize: string; fingerprint: string };
export function sameProductionContent(job: Version, sourceKey: string, parameters: ProductionParameters) {
  const target = productionFingerprint(sourceKey, parameters, job.textSize);
  if (job.fingerprint === target) return true;
  const saved = job.parameters as ProductionParameters;
  // Reuse existing ready/pending/leased files without updating their lease or causing
  // a mass re-render on deployment. Unknown renderer versions are still invalidated.
  return job.fingerprint === legacyFingerprint(job.sourceKey, saved, job.textSize)
    && productionFingerprint(job.sourceKey, saved, job.textSize) === target;
}

export function productionChanges(job: Version, sourceKey: string, parameters: ProductionParameters): ProductionChange[] {
  const before = productionContent(job.parameters as ProductionParameters);
  const after = productionContent(parameters);
  const changes: ProductionChange[] = [];
  for (const field of Object.keys(after)) {
    if (JSON.stringify(before[field]) !== JSON.stringify(after[field])) changes.push({ field, before: before[field], after: after[field] });
  }
  if (job.sourceKey !== sourceKey) changes.push({ field: 'sourceFile', before: job.sourceKey, after: sourceKey });
  if (!changes.length && !sameProductionContent(job, sourceKey, parameters)) changes.push({ field: 'renderer', before: 'Предыдущая версия', after: 'Текущая версия' });
  return changes;
}
