// Run after npm run build. Exercises the real deletion orchestration and durable
// cleanup enqueue logic against a deterministic transaction adapter; no S3/DB I/O.
const assert = require('node:assert/strict');
const { OrderLifecycleService } = require('../dist/orders/order-lifecycle.service');
const { ProductionFilesService } = require('../dist/orders/production-files.service');
const { StorageCleanupService } = require('../dist/storage/storage-cleanup.service');
const { imagePreviewKeys } = require('../dist/storage/image-preview');
const { CLEANUP_DELAY_MS, LIFECYCLE_STATUSES } = require('../dist/orders/order-lifecycle.policy');

function fixture() {
  let locked = false;
  let attachments = Array.from({ length: 101 }, (_, index) => ({
    id: index + 1, printPhotoOrderId: 1, objectKey: `original-${index}.png`,
    thumbnailKey: `thumb-${index}.png`, previewKey: `preview-${index}.png`,
    previewStatus: index === 0 ? 'pending' : 'ready',
  }));
  // This source remains referenced by a different order after the batch.
  attachments.push({ id: 200, printPhotoOrderId: 2, objectKey: 'original-1.png' });
  const info = { orderStatusId: LIFECYCLE_STATUSES.delivered,
    rawPayload: { customFields: [{ fieldName: 'Дедлайн отправки', value: '01.01.2000' }] } };
  const tag = { id: 1, orderId: 1, kind: 'ATTACHMENT_CLEANUP',
    markedAt: new Date(Date.now() - CLEANUP_DELAY_MS - 60_000), completedAt: null };
  const deletions = new Map();
  let production = [
    { attachmentId: 1, objectKey: 'production-ready.png', status: 'ready' },
    { attachmentId: 2, objectKey: 'production-inflight.png', status: 'processing', leaseUntil: new Date(Date.now() + 600_000) },
  ];
  const tx = {
    $queryRaw: async () => { locked = true; },
    bluesalesOrderInfo: { findUnique: async () => { assert.ok(locked); return info; } },
    orderSystemTag: { findUnique: async () => tag, update: async ({ data }) => Object.assign(tag, data) },
    attachment: {
      findMany: async ({ take, orderBy }) => {
        assert.equal(take, 100); assert.deepEqual(orderBy, { id: 'asc' });
        return attachments.filter((a) => a.printPhotoOrderId === 1).slice(0, take);
      },
      deleteMany: async ({ where }) => { attachments = attachments.filter((a) => !where.id.in.includes(a.id)); },
      count: async ({ where }) => attachments.filter((a) => where.objectKey
        ? a.objectKey === where.objectKey : a.printPhotoOrderId === 1).length,
    },
    productionFile: {
      findMany: async ({ where }) => production.filter((p) => where.attachmentId.in.includes(p.attachmentId)),
      deleteMany: async ({ where }) => { production = production.filter((p) => !where.attachmentId.in.includes(p.attachmentId)); },
    },
    storedFileDeletion: { upsert: async ({ create }) => deletions.set(create.objectKey, create) },
  };
  const db = { $transaction: async (fn, options) => { assert.equal(options.timeout, 30_000); return fn(tx); } };
  const cleanup = new StorageCleanupService(db, {});
  const service = new OrderLifecycleService(db, cleanup, new ProductionFilesService(db, {}, cleanup), {});
  return { service, info, tag, deletions, attachments: () => attachments };
}

async function main() {
  const f = fixture();
  const started = Date.now();
  await f.service.deleteBatch(1, 1);
  assert.equal(f.attachments().filter((a) => a.printPhotoOrderId === 1).length, 1);
  assert.equal(f.tag.completedAt, null, 'partial batch must not complete the tag');
  for (const key of ['original-0.png', 'thumb-0.png', 'preview-0.png', ...Object.values(imagePreviewKeys('original-0.png'))]) {
    assert.ok(f.deletions.has(key), `missing durable cleanup for ${key}`);
    assert.ok(f.deletions.get(key).nextAttemptAt.getTime() >= started + 600_000, 'preview race grace period');
  }
  for (const key of ['original-1.png', 'thumb-1.png', 'preview-1.png', ...Object.values(imagePreviewKeys('original-1.png'))]) {
    assert.ok(!f.deletions.has(key), `shared source must survive: ${key}`);
  }
  assert.ok(f.deletions.has('production-ready.png'));
  assert.ok(f.deletions.get('production-inflight.png').nextAttemptAt.getTime() >= started + 590_000);
  await f.service.deleteBatch(1, 1);
  assert.ok(f.tag.completedAt instanceof Date);
  assert.deepEqual(f.attachments().map((a) => a.id), [200]);

  for (const invalidate of [
    (x) => { x.info.orderStatusId = -1; },
    (x) => { x.info.rawPayload = {}; },
    (x) => { x.tag.markedAt = new Date(); },
    (x) => { x.tag.completedAt = new Date(); },
  ]) {
    const stale = fixture(); invalidate(stale);
    await stale.service.deleteBatch(1, 1);
    assert.equal(stale.attachments().length, 102);
    assert.equal(stale.deletions.size, 0);
  }
  console.log('Lifecycle deletion: 100-item batches, shared sources, all variants, upload leases and stale eligibility passed.');
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
