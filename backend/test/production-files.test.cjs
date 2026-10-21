// Run after npm run build: node --test test/production-files.test.cjs
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { writeFile, readFile } = require('node:fs/promises');
const { Readable } = require('node:stream');
const sharp = require('sharp');
const { ProductionFilesService } = require('../dist/orders/production-files.service');
const { StorageCleanupService } = require('../dist/storage/storage-cleanup.service');
const { productionImage, productionTextScale } = require('../dist/orders/production-image');
const { ImagePreviewQueue } = require('../dist/storage/image-preview');

function matches(row, where = {}) {
  return Object.entries(where).every(([key, value]) => {
    if (key === 'OR') return value.some((part) => matches(row, part));
    if (key === 'orderId_attachmentId_textSize') return matches(row, value);
    if (value instanceof Date) return row[key]?.getTime() === value.getTime();
    if (value && typeof value === 'object') {
      if ('lte' in value) return row[key] != null && row[key] <= value.lte;
      if ('in' in value) return value.in.includes(row[key]);
      if ('not' in value) return row[key] !== value.not;
      if ('gt' in value) return row[key] > value.gt;
      return matches(row[key] || {}, value);
    }
    return row[key] === value;
  });
}

function table(rows, defaults = {}) {
  const find = (where) => rows.find((row) => matches(row, where));
  const ordered = (where, orderBy) => rows.filter((row) => matches(row, where)).sort((a, b) => {
    for (const order of Array.isArray(orderBy) ? orderBy : orderBy ? [orderBy] : []) {
      for (const [key, direction] of Object.entries(order)) {
        if (a[key] < b[key]) return direction === 'asc' ? -1 : 1;
        if (a[key] > b[key]) return direction === 'asc' ? 1 : -1;
      }
    }
    return 0;
  });
  const update = (row, data) => {
    for (const [key, value] of Object.entries(data)) row[key] = value && typeof value === 'object' && 'increment' in value
      ? row[key] + value.increment : value;
    row.updatedAt = new Date(row.updatedAt.getTime() + 1);
    return { ...row };
  };
  return {
    findUnique: async ({ where }) => { const row = find(where); return row ? { ...row } : null; },
    findFirst: async ({ where, orderBy }) => { const row = ordered(where, orderBy)[0]; return row ? { ...row } : null; },
    findMany: async ({ where, orderBy }) => ordered(where, orderBy).map((row) => ({ ...row })),
    count: async ({ where }) => rows.filter((row) => matches(row, where)).length,
    upsert: async ({ where, create, update: data }) => {
      const previous = find(where);
      if (previous) return update(previous, data);
      const row = { id: rows.length + 1, createdAt: new Date(), updatedAt: new Date(), ...defaults, ...create };
      rows.push(row);
      return { ...row };
    },
    updateMany: async ({ where, data }) => {
      const targets = rows.filter((row) => matches(row, where));
      targets.forEach((row) => update(row, data));
      return { count: targets.length };
    },
    deleteMany: async ({ where }) => {
      let count = 0;
      for (let i = rows.length - 1; i >= 0; i--) if (matches(rows[i], where)) { rows.splice(i, 1); count++; }
      return { count };
    },
  };
}

async function setup() {
  const source = await sharp({ create: { width: 180, height: 240, channels: 3, background: '#19708e' } })
    .withMetadata({ density: 300 }).png().toBuffer();
  const jobs = [], events = [], deletions = [], objects = new Map(), removals = [];
  const order = { id: 10, orderNumber: '12345', pinnedSketches: [], bluesalesInfo: { rawPayload: { internalComments: 'Матовая' } } };
  const photos = [{ id: 7, objectKey: 'original.png', printPhotoOrderId: 10, filename: 'original.png', mimeType: 'image/png' }];
  const prisma = {
    order: { findUnique: async ({ where }) => where.id === order.id ? order : null },
    attachment: table(photos), productionFile: table(jobs),
    productionTaskEvent: { create: async ({ data }) => { const event = { ...data, createdAt: new Date() }; events.push(event); return event; } },
    storedFileDeletion: table(deletions, { generation: 0, attempts: 0, nextAttemptAt: new Date() }),
    $transaction: async (operation) => operation(prisma),
  };
  const storage = {
    runImageJob: async (operation) => operation(),
    downloadToFile: async (key, path) => { assert.equal(key, 'original.png'); await writeFile(path, source); },
    uploadPreparedFile: async (key, path) => { const data = await readFile(path); objects.set(key, data); return data.length; },
    getStream: async (key) => { assert.ok(objects.has(key)); return Readable.from(objects.get(key)); },
    removeStoredObject: async (key) => { removals.push(key); objects.delete(key); },
  };
  const cleanup = new StorageCleanupService(prisma, storage);
  const service = new ProductionFilesService(prisma, storage, cleanup);
  service.logger.warn = cleanup.logger.warn = () => {};
  return { service, cleanup, prisma, storage, jobs, events, deletions, objects, removals, order, photos, source };
}

test('upload queues work without decoding; pending download returns 409; worker caches lossless PNG', async () => {
  const h = await setup();
  let sourceReads = 0;
  const download = h.storage.downloadToFile;
  h.storage.downloadToFile = async (...args) => { sourceReads++; return download(...args); };
  await h.service.queueOrder(10, '40x60');
  assert.equal(sourceReads, 0);
  assert.equal(h.jobs[0].textSize, '40x60');
  assert.deepEqual(h.jobs.map((job) => job.textSize), ['40x60', '30x40', '60x80']);
  assert.equal((await h.service.status(10, 7, '40x60')).status, 'pending');
  await assert.rejects(h.service.download(10, 7, '40x60'), (error) => error.getStatus() === 409);
  await h.service.processNext();
  assert.equal(h.jobs[0].status, 'ready');
  const output = h.objects.get(h.jobs[0].objectKey);
  const metadata = await sharp(output).metadata();
  assert.equal(metadata.width, 180);
  assert.ok(metadata.height > 240);
  assert.equal(metadata.density, 300);
  assert.equal(metadata.channels, 3);
  const expected = await (await productionImage(h.source, '12345-1', [], 'Матовая', productionTextScale('40x60'))).raw().toBuffer();
  assert.deepEqual(await sharp(output).raw().toBuffer(), expected, 'the cached PNG must print order number plus photo ordinal');
  assert.deepEqual(await sharp(output).extract({ left: 0, top: metadata.height - 240, width: 180, height: 240 }).raw().toBuffer(), await sharp(h.source).raw().toBuffer());
  const file = await h.service.download(10, 7, '40x60');
  assert.equal(file.getHeaders().length, output.length);
  assert.ok(file.getHeaders().disposition.includes('production-12345-7.png'));
  await h.service.status(10, 7, '40x60');
  assert.equal(sourceReads, 1, 'downloads reuse the cache');
});

test('backfill queues all sizes for old photos, skips PDF/DNG, and preserves existing results on repeated scans', async () => {
  const h = await setup();
  await h.service.ensure(10, 7, '30x40');
  await h.service.processNext();
  const ready = { ...h.jobs[0] };
  h.photos.push(
    { ...h.photos[0], id: 8 },
    { ...h.photos[0], id: 9, filename: 'document.pdf', mimeType: 'application/pdf' },
    { ...h.photos[0], id: 10, filename: 'raw.DNG' },
  );
  await h.service.synchronize();
  assert.equal(h.jobs.length, 6);
  for (const attachmentId of [7, 8]) {
    assert.deepEqual(h.jobs.filter((job) => job.attachmentId === attachmentId).map((job) => job.textSize).sort(), ['30x40', '40x60', '60x80']);
  }
  assert.deepEqual(h.jobs.find((job) => job.id === ready.id), ready);
  assert.ok(h.jobs.filter((job) => job.id !== ready.id).every((job) => job.status === 'pending' && job.attempts === 0));
  await h.service.synchronize();
  assert.equal(h.jobs.length, 6, 'rescanning must not duplicate jobs');
  assert.deepEqual(h.jobs.find((job) => job.id === ready.id), ready);
  assert.equal(h.deletions.length, 0);
});

test('production dispatch claims distinct jobs in parallel and shares four slots with previews', async () => {
  const h = await setup();
  for (const id of [8, 9, 10, 11]) h.photos.push({ ...h.photos[0], id });
  for (const photo of h.photos) await h.service.ensure(10, photo.id, '30x40');
  const queue = new ImagePreviewQueue();
  h.storage.runImageJob = (operation) => queue.run(operation, 'production');
  let releasePreview;
  const preview = queue.run(() => new Promise((resolve) => { releasePreview = resolve; }));
  const releases = new Map();
  const started = [];
  h.service.prepare = async (job) => {
    started.push(job.id);
    await new Promise((resolve) => releases.set(job.id, resolve));
    await h.prisma.productionFile.updateMany({ where: { id: job.id, runToken: job.runToken }, data: { status: 'ready', runToken: null } });
  };
  const first = h.service.processAvailable();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(started.length, 3);
  assert.equal(new Set(started).size, 3, 'lost claims must retry rather than render duplicates');
  assert.deepEqual(queue.snapshot(), { preview: { waiting: 0, running: 1 }, production: { waiting: 1, running: 3 } });
  await h.service.processAvailable();
  assert.equal(started.length, 3, 'polling must not grow the local production queue beyond four consumers');
  releasePreview();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(started.length, 4);
  releases.get(started[0])();
  await new Promise((resolve) => setImmediate(resolve));
  const refill = h.service.processAvailable();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(started.length, 5);
  assert.equal(queue.snapshot().production.running, 4);
  releases.forEach((release) => release());
  await Promise.all([first, refill, preview]);
  assert.equal(new Set(started).size, 5);
  assert.ok(h.jobs.every((job) => job.status === 'ready' && job.attempts === 1));
  assert.equal(h.service.running, 0);
  assert.deepEqual(queue.snapshot(), { preview: { waiting: 0, running: 0 }, production: { waiting: 0, running: 0 } });
});

test('expediting a selected size jumps ahead of a saturated shared backlog without rendering twice', async () => {
  const h = await setup();
  for (const id of [8, 9, 10, 11]) h.photos.push({ ...h.photos[0], id });
  for (const photo of h.photos) await h.service.ensure(10, photo.id, '30x40');
  const urgent = await h.service.ensure(10, 7, '60x80');
  const queue = new ImagePreviewQueue(1);
  h.storage.runImageJob = (operation, priority) => queue.run(operation, 'production', priority);
  let releasePreview, releaseUrgent;
  const preview = queue.run(() => new Promise((resolve) => { releasePreview = resolve; }));
  const started = [];
  h.service.prepare = async (job) => {
    started.push({ id: job.id, textSize: job.textSize });
    if (job.id === urgent.id) await new Promise((resolve) => { releaseUrgent = resolve; });
    await h.prisma.productionFile.updateMany({ where: { id: job.id, runToken: job.runToken }, data: { status: 'ready', runToken: null } });
    return true;
  };
  const background = h.service.processAvailable();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(queue.snapshot().production.waiting, 4);
  await Promise.all([h.service.expedite(10, 7, '60x80'), h.service.expedite(10, 7, '60x80')]);
  assert.equal(queue.snapshot().production.waiting, 5, 'repeated expedite requests share one urgent dispatch');
  assert.equal(h.jobs.find((job) => job.id === urgent.id).priority, 1);
  assert.ok(h.jobs.filter((job) => job.id !== urgent.id).every((job) => job.priority === 0), 'other sizes retain background priority');
  releasePreview();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(started, [{ id: urgent.id, textSize: '60x80' }]);
  assert.equal(queue.snapshot().production.running, 1, 'urgent dispatch still obeys the shared image limit');
  await h.service.expedite(10, 7, '60x80');
  assert.equal(queue.snapshot().production.waiting, 4, 'processing jobs are never dispatched again');
  releaseUrgent();
  await Promise.all([background, preview]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(started.filter((job) => job.id === urgent.id).length, 1);
  assert.equal(h.jobs.find((job) => job.id === urgent.id).attempts, 1);
  assert.equal(h.service.running, 0);
});

test('persisted priority survives dispatch restart and selects urgent work before older jobs', async () => {
  const h = await setup();
  const old = await h.service.ensure(10, 7, '30x40');
  const urgent = await h.service.ensure(10, 7, '40x60');
  Object.assign(h.jobs.find((job) => job.id === urgent.id), { priority: 1, createdAt: new Date(old.createdAt.getTime() + 1000) });
  const restarted = new ProductionFilesService(h.prisma, h.storage, h.cleanup);
  restarted.logger.warn = () => {};
  await restarted.processNext();
  assert.equal(h.jobs.find((job) => job.id === urgent.id).status, 'ready');
  assert.equal(h.jobs.find((job) => job.id === old.id).status, 'pending');
});

test('expedite preserves a live processing lease and a ready cache', async () => {
  const h = await setup();
  await h.service.ensure(10, 7, '40x60');
  const lease = new Date(Date.now() + 60_000);
  Object.assign(h.jobs[0], { status: 'processing', runToken: 'live', leaseUntil: lease, attempts: 2, objectKey: 'production/live.png' });
  const running = { ...h.jobs[0] };
  assert.equal((await h.service.expedite(10, 7, '40x60')).status, 'processing');
  assert.deepEqual(h.jobs[0], running);
  Object.assign(h.jobs[0], { status: 'ready', runToken: null, leaseUntil: null });
  const ready = { ...h.jobs[0] };
  assert.equal((await h.service.expedite(10, 7, '40x60')).status, 'ready');
  assert.deepEqual(h.jobs[0], ready);
  assert.equal(h.deletions.length, 0);
});

test('expedite reclaims an expired processing lease with priority and cleans its abandoned object', async () => {
  const h = await setup();
  await h.service.ensure(10, 7, '40x60');
  Object.assign(h.jobs[0], { status: 'processing', runToken: 'crashed', leaseUntil: new Date(0), attempts: 1, objectKey: 'production/abandoned.png' });
  let dispatch;
  h.storage.runImageJob = (operation, priority) => {
    assert.equal(priority, true);
    dispatch = operation;
    return Promise.resolve();
  };
  const response = await h.service.expedite(10, 7, '40x60');
  assert.equal(response.expedited, true);
  assert.equal(h.jobs[0].runToken, 'crashed', 'expedite marks urgency without resetting the old claim');
  assert.equal(typeof dispatch, 'function');
  await dispatch();
  assert.equal(h.jobs[0].status, 'ready');
  assert.equal(h.jobs[0].attempts, 2);
  assert.notEqual(h.jobs[0].objectKey, 'production/abandoned.png');
  assert.ok(h.deletions.some((row) => row.objectKey === 'production/abandoned.png'));
});

test('expedite validates attachment ownership, selected size and raster format before dispatch', async () => {
  const h = await setup();
  await assert.rejects(h.service.expedite(99, 7), (error) => error.getStatus() === 404);
  await assert.rejects(h.service.expedite(10, 7, 'bad-size'), (error) => error.getStatus() === 400);
  h.photos[0].printPhotoOrderId = null;
  h.order.pinnedSketches = [{ messageId: 22 }];
  h.photos[0].message = { id: 22, orderId: 99 };
  await assert.rejects(h.service.expedite(10, 7), (error) => error.getStatus() === 404);
  h.photos[0].message.orderId = 10;
  await assert.rejects(h.service.expedite(10, 7), (error) => error.getStatus() === 404);
  h.photos[0].printPhotoOrderId = 10;
  h.photos[0].filename = 'file.pdf';
  await assert.rejects(h.service.expedite(10, 7), (error) => error.getStatus() === 400);
  assert.equal(h.jobs.length, 0);
  assert.equal(h.service.running, 0);
});

test('header changes invalidate the cached result and enqueue deletion of the old version', async () => {
  const h = await setup();
  await h.service.ensure(10, 7);
  await h.service.processNext();
  const oldKey = h.jobs[0].objectKey;
  h.order.bluesalesInfo.rawPayload.internalComments = 'Глянцевая';
  await assert.rejects(h.service.download(10, 7), (error) => error.getStatus() === 409);
  assert.equal(h.jobs[0].status, 'pending');
  assert.equal(h.deletions[0].objectKey, oldKey);
  await h.service.processNext();
  assert.notEqual(h.jobs[0].objectKey, oldKey);
  await h.cleanup.processBatch();
  assert.ok(!h.objects.has(oldKey));
  assert.equal(h.objects.size, 1);
});

test('photo ordinals follow production attachment order, are scoped to the order, and refresh after removal', async () => {
  const h = await setup();
  h.photos.push(
    { ...h.photos[0], id: 90 }, { ...h.photos[0], id: 22 },
    { ...h.photos[0], id: 1, printPhotoOrderId: 99 },
  );
  const third = await h.service.ensure(10, 90);
  assert.equal(third.parameters.photoNumber, 3);
  assert.equal((await h.service.ensure(10, 7)).parameters.photoNumber, 1);
  assert.equal((await h.service.ensure(10, 22)).parameters.photoNumber, 2);
  await h.service.processNext(); // Cached third photo has label 12345-3.
  const oldKey = h.jobs.find((row) => row.attachmentId === 90).objectKey;
  await h.service.scheduleDeletion(h.prisma, { orderId: 10, attachmentId: 22 });
  h.photos.splice(h.photos.findIndex((photo) => photo.id === 22), 1);
  await h.service.queueOrder(10);
  const renumbered = h.jobs.find((row) => row.attachmentId === 90);
  assert.equal(renumbered.parameters.photoNumber, 2);
  assert.equal(renumbered.status, 'pending');
  assert.ok(h.deletions.some((row) => row.objectKey === oldKey));
  assert.equal(h.jobs.find((row) => row.attachmentId === 7).parameters.photoNumber, 1);
});

test('deleting a photo during upload cleans its late result and every cached text size', async () => {
  const h = await setup();
  await h.service.ensure(10, 7, '30x40');
  await h.service.ensure(10, 7, '60x80');
  await h.service.processNext();
  const firstKey = h.jobs.find((row) => row.status === 'ready').objectKey;
  const upload = h.storage.uploadPreparedFile;
  h.storage.uploadPreparedFile = async (key, path) => {
    await h.service.scheduleDeletion(h.prisma, { orderId: 10, attachmentId: 7 });
    h.photos.length = 0;
    await h.cleanup.processBatch(); // Both keys removed before the second result arrives.
    return upload(key, path);
  };
  await h.service.processNext();
  assert.equal(h.jobs.length, 0);
  assert.equal(h.objects.size, 1, 'late result must have a durable deletion request');
  assert.equal(h.deletions.length, 1);
  await h.cleanup.processBatch();
  assert.equal(h.objects.size, 0);
  assert.ok(h.removals.includes(firstKey));
  assert.ok(!h.removals.includes('original.png'), 'production cleanup never removes a shared source');
});

test('deletion requeued during cleanup survives the old cleanup completion', async () => {
  const h = await setup();
  await h.cleanup.enqueue(['production/late.png', 'production/late.png']);
  const remove = h.storage.removeStoredObject;
  let requeued = false;
  h.storage.removeStoredObject = async (key) => {
    await remove(key);
    if (!requeued) {
      requeued = true;
      h.objects.set(key, Buffer.from('late upload'));
      await h.cleanup.enqueue([key]);
    }
  };
  await h.cleanup.processBatch();
  assert.equal(h.deletions.length, 1);
  assert.equal(h.deletions[0].generation, 1);
  await h.cleanup.processBatch();
  assert.equal(h.deletions.length, 0);
  assert.equal(h.objects.size, 0);
});

test('deletion waits for an in-flight lease so a crash after upload still leaves a cleanup trail', async () => {
  const h = await setup();
  await h.service.ensure(10, 7);
  const key = 'production/crashed-after-upload.png';
  const leaseUntil = new Date(Date.now() + 600_000);
  Object.assign(h.jobs[0], { status: 'processing', objectKey: key, leaseUntil });
  await h.service.scheduleDeletion(h.prisma, { orderId: 10, attachmentId: 7 });
  await h.cleanup.processBatch();
  assert.equal(h.removals.length, 0, 'an unfinished upload must retain its cleanup request');
  h.objects.set(key, Buffer.from('uploaded just before crash'));
  h.deletions[0].nextAttemptAt = new Date(0);
  await h.cleanup.processBatch();
  assert.equal(h.objects.size, 0);
  assert.equal(h.deletions.length, 0);
});

test('a header changed during rendering is requeued and never published with stale data', async () => {
  const h = await setup();
  await h.service.ensure(10, 7);
  const download = h.storage.downloadToFile;
  h.storage.downloadToFile = async (...args) => {
    await download(...args);
    h.order.orderNumber = '54321';
  };
  await h.service.processNext();
  assert.equal(h.jobs[0].status, 'pending');
  assert.equal(h.jobs[0].parameters.orderNumber, '54321');
  assert.equal(h.objects.size, 0);
});

test('storage outage keeps cleanup durable and retries it later', async () => {
  const h = await setup();
  await h.cleanup.enqueue(['production/file.png']);
  const remove = h.storage.removeStoredObject;
  h.storage.removeStoredObject = async () => { throw new Error('offline'); };
  await h.cleanup.processBatch();
  assert.equal(h.deletions[0].attempts, 1);
  assert.ok(h.deletions[0].nextAttemptAt > new Date());
  h.deletions[0].nextAttemptAt = new Date(0);
  h.storage.removeStoredObject = remove;
  await h.cleanup.processBatch();
  assert.equal(h.deletions.length, 0);
});

test('failed jobs stop after three attempts and can be explicitly retried', async () => {
  const h = await setup();
  h.storage.downloadToFile = async () => { throw new Error('offline'); };
  await h.service.ensure(10, 7);
  for (let i = 0; i < 3; i++) {
    h.jobs[0].nextAttemptAt = new Date(0);
    await h.service.processNext();
  }
  assert.equal(h.jobs[0].status, 'failed');
  assert.equal(h.jobs[0].attempts, 3);
  await assert.rejects(h.service.download(10, 7), (error) => error.getStatus() === 400);
  assert.equal((await h.service.status(10, 7, undefined, true)).status, 'pending');
  assert.equal(h.jobs[0].attempts, 0);
});

test('expired lease after restart is reclaimed with a new key and cleans the abandoned key', async () => {
  const h = await setup();
  await h.service.ensure(10, 7);
  Object.assign(h.jobs[0], { status: 'processing', runToken: 'crashed', objectKey: 'production/crashed.png', leaseUntil: new Date(0), attempts: 1 });
  await h.service.processNext();
  assert.equal(h.jobs[0].status, 'ready');
  assert.equal(h.jobs[0].attempts, 2);
  assert.notEqual(h.jobs[0].objectKey, 'production/crashed.png');
  assert.ok(h.deletions.some((row) => row.objectKey === 'production/crashed.png'));
});

test('all production endpoints reject chat photos and pinned sketches until explicitly attached for print', async () => {
  const h = await setup();
  await assert.rejects(h.service.status(99, 7), (error) => error.getStatus() === 404);
  h.photos[0].printPhotoOrderId = null;
  await assert.rejects(h.service.status(10, 7), (error) => error.getStatus() === 404);
  h.order.pinnedSketches = [{ messageId: 22 }];
  h.photos[0].message = { id: 22, orderId: 99 };
  await assert.rejects(h.service.download(10, 7), (error) => error.getStatus() === 404);
  h.photos[0].message.orderId = 10;
  for (const method of ['ensure', 'status', 'download', 'expedite']) {
    await assert.rejects(h.service[method](10, 7), (error) => error.getStatus() === 404, method);
  }
  assert.equal(h.jobs.length, 0);
  h.photos[0].printPhotoOrderId = 99;
  await assert.rejects(h.service.status(10, 7), (error) => error.getStatus() === 404);
  h.photos[0].printPhotoOrderId = 10;
  assert.equal((await h.service.status(10, 7)).status, 'pending');
  assert.equal(h.jobs[0].parameters.photoNumber, 1);
  await assert.rejects(h.service.status(10, 7, 'bad'), (error) => error.getStatus() === 400);
  for (const extension of ['pdf', 'DNG']) {
    h.photos[0].filename = `photo.${extension}`;
    await assert.rejects(h.service.download(10, 7), (error) => error.getStatus() === 400);
  }
});

test('upload and historical backfill queue only print photos, never ordinary or pinned chat attachments', async () => {
  const h = await setup();
  h.order.pinnedSketches = [{ messageId: 22 }];
  h.photos.push(
    { ...h.photos[0], id: 8, printPhotoOrderId: null, message: { id: 21, orderId: 10 } },
    { ...h.photos[0], id: 9, printPhotoOrderId: null, message: { id: 22, orderId: 10 } },
    { ...h.photos[0], id: 10, printPhotoOrderId: null, chatMessageId: 23 },
  );
  await h.service.queueOrder(10);
  await h.service.synchronize();
  assert.equal(h.jobs.length, 3);
  assert.ok(h.jobs.every((job) => job.attachmentId === 7));
});

test('legacy queued chat variants are discarded before reading originals and do not count as conversions', async () => {
  const h = await setup();
  await h.service.queueOrder(10);
  h.photos[0].printPhotoOrderId = null;
  h.photos[0].message = { id: 22, orderId: 10 };
  h.order.pinnedSketches = [{ messageId: 22 }];
  h.storage.downloadToFile = async () => assert.fail('Chat originals must not be downloaded for production');
  h.storage.uploadPreparedFile = async () => assert.fail('Chat photos must not produce production files');
  const queue = new ImagePreviewQueue(1);
  h.storage.runImageJob = (operation) => queue.run(operation, 'production', false, (result) => result === undefined ? null : result);
  for (let i = 0; i < 3; i++) await h.service.processNext();
  assert.equal(h.jobs.length, 0);
  assert.equal(queue.recentMeasurements().filter((row) => row.success).length, 0);
  assert.equal(h.objects.size, 0);
  assert.ok(h.deletions.every((row) => row.objectKey.startsWith('production/')));
});

test('a header changed while queued is refreshed before decoding, then rendered only once', async () => {
  const h = await setup();
  await h.service.ensure(10, 7);
  h.order.orderNumber = '54321';
  let sourceReads = 0;
  const download = h.storage.downloadToFile;
  h.storage.downloadToFile = async (...args) => { sourceReads++; return download(...args); };
  await h.service.processNext();
  assert.equal(sourceReads, 0);
  assert.equal(h.jobs[0].status, 'pending');
  assert.equal(h.jobs[0].parameters.orderNumber, '54321');
  await h.service.processNext();
  assert.equal(sourceReads, 1);
  assert.equal(h.jobs[0].status, 'ready');
});

test('enqueue journal records twelve new tasks for four photos and ignores cache/status/backfill reads', async () => {
  const h = await setup();
  h.photos.push(...[8, 9, 10].map((id) => ({ ...h.photos[0], id })));
  await h.service.queueOrder(10);
  assert.equal(h.events.length, 12);
  assert.equal(new Set(h.events.map((event) => event.attachmentId)).size, 4);
  assert.ok(h.events.every((event) => event.reason === 'created' && event.orderNumber === '12345'));
  await h.service.queueOrder(10);
  await h.service.synchronize();
  await h.service.status(10, 7);
  assert.equal(h.events.length, 12);
  await h.service.scheduleDeletion(h.prisma, { orderId: 10, attachmentId: 7 });
  assert.equal(h.events.length, 12, 'deleting a queued photo must not erase the debug history');
});

test('enqueue journal distinguishes changed content and manual retries from automatic worker attempts', async () => {
  const h = await setup();
  await h.service.ensure(10, 7);
  h.storage.downloadToFile = async () => { throw new Error('offline'); };
  await h.service.processNext();
  assert.equal(h.events.length, 1, 'a failed worker attempt is not a new enqueue');
  Object.assign(h.jobs[0], { status: 'failed', attempts: 3 });
  await h.service.status(10, 7, undefined, true);
  await h.service.status(10, 7, undefined, true);
  h.order.orderNumber = '54321';
  await h.service.ensure(10, 7);
  assert.deepEqual(h.events.map((event) => event.reason), ['created', 'retry', 'changed']);
  assert.equal(h.events[2].orderNumber, '54321');
});
