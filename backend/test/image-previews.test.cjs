// Run after npm run build: node --test test/image-previews.test.cjs
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, rmdir, unlink, stat, writeFile, access } = require('node:fs/promises');
const { join, dirname } = require('node:path');
const { tmpdir } = require('node:os');
const { createReadStream } = require('node:fs');
const { createHash, randomFillSync } = require('node:crypto');
const sharp = require('sharp');
const { renderImagePreviews, ImagePreviewQueue, imagePreviewKeys } = require('../dist/storage/image-preview');
const { StorageService } = require('../dist/storage/storage.service');
const { AttachmentsService } = require('../dist/storage/attachments.service');
const { AttachmentPreviewsService } = require('../dist/storage/attachment-previews.service');

async function digest(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}
const smallImage = () => sharp({ create: { width: 50, height: 40, channels: 3, background: 'red' } }).png().toBuffer();

test('a 30+ MB image yields small WebP variants without changing the original', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'metalica-preview-test-'));
  const path = join(directory, 'large.png');
  try {
    await sharp(randomFillSync(Buffer.alloc(4000 * 3000 * 3)), { raw: { width: 4000, height: 3000, channels: 3 } })
      .png({ compressionLevel: 0 }).toFile(path);
    const originalSize = (await stat(path)).size;
    const originalHash = await digest(path);
    const result = await renderImagePreviews(path);
    assert.ok(originalSize > 30 * 1024 * 1024);
    for (const [name, size, maxBytes] of [['thumbnail', 600, 200_000], ['preview', 1800, 2_000_000]]) {
      const metadata = await sharp(result[name]).metadata();
      assert.equal(metadata.format, 'webp');
      assert.equal(metadata.width, size);
      assert.equal(metadata.height, size * 3 / 4);
      assert.ok(result[name].length < maxBytes);
    }
    assert.equal(await digest(path), originalHash);
    console.log(`Large image: ${originalSize} bytes -> ${result.thumbnail.length} / ${result.preview.length} bytes`);
  } finally {
    await unlink(path).catch(() => {});
    await rmdir(directory);
  }
});

test('EXIF rotation is applied and small images are not enlarged', async () => {
  const input = await sharp({ create: { width: 240, height: 400, channels: 3, background: 'blue' } })
    .withMetadata({ orientation: 6 }).jpeg().toBuffer();
  const { thumbnail, preview } = await renderImagePreviews(input);
  for (const output of [thumbnail, preview]) {
    const metadata = await sharp(output).metadata();
    assert.equal(metadata.width, 400);
    assert.equal(metadata.height, 240);
    assert.equal(metadata.orientation, undefined);
  }
});

test('HEIC is rendered in the server worker', { skip: !process.env.HEIC_TEST_FILE }, async () => {
  const { thumbnail, preview } = await renderImagePreviews(process.env.HEIC_TEST_FILE);
  assert.equal((await sharp(thumbnail).metadata()).format, 'webp');
  assert.equal((await sharp(preview).metadata()).format, 'webp');
});

test('preview queue serializes jobs and continues after a failure', async () => {
  const queue = new ImagePreviewQueue(1);
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const events = [];
  const failure = assert.rejects(queue.run(async () => { events.push('first'); await gate; throw new Error('broken'); }), /broken/);
  const second = queue.run(async () => { events.push('second'); return 42; }, 'production');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ['first']);
  assert.deepEqual(queue.snapshot(), { preview: { waiting: 0, running: 1 }, production: { waiting: 1, running: 0 } });
  const snapshot = queue.snapshot();
  snapshot.preview.running = 99;
  assert.equal(queue.snapshot().preview.running, 1, 'snapshot must not expose mutable queue counters');
  release();
  await failure;
  assert.equal(await second, 42);
  assert.deepEqual(events, ['first', 'second']);
  assert.deepEqual(queue.snapshot(), { preview: { waiting: 0, running: 0 }, production: { waiting: 0, running: 0 } });
});

test('shared queue runs four image jobs, refills freed slots, and counts both job types after failures', async () => {
  const queue = new ImagePreviewQueue();
  const releases = [];
  const started = [];
  let active = 0, maximum = 0;
  const jobs = Array.from({ length: 7 }, (_, i) => {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    releases.push(release);
    return queue.run(async () => {
      started.push(i);
      maximum = Math.max(maximum, ++active);
      await gate;
      active--;
      if (i === 0) throw new Error('first failed');
      return i;
    }, i % 2 ? 'production' : 'preview');
  });
  const results = Promise.allSettled(jobs);
  assert.deepEqual(started, [0, 1, 2, 3]);
  assert.deepEqual(queue.snapshot(), { preview: { waiting: 2, running: 2 }, production: { waiting: 1, running: 2 } });
  releases[0]();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(started, [0, 1, 2, 3, 4]);
  assert.equal(active, 4, 'a failure must immediately free a slot for the next job');
  releases.forEach((release) => release());
  assert.equal((await results)[0].status, 'rejected');
  assert.equal(maximum, 4, 'uploads, previews and production must share one limit');
  assert.deepEqual(queue.snapshot(), { preview: { waiting: 0, running: 0 }, production: { waiting: 0, running: 0 } });
});

test('preview backfill runs four distinct sources and refills without waiting for slower jobs', async () => {
  const rows = ['a', 'b', 'c', 'd', 'a', 'e'].map((objectKey, index) => ({ id: index + 1, objectKey, previewStatus: 'pending', previewAttempts: 0 }));
  const releases = new Map();
  const started = [];
  const prisma = { attachment: {
    findMany: async ({ where, take }) => rows.filter((row) => row.previewStatus === 'pending' && !where.objectKey.notIn.includes(row.objectKey)).slice(0, take),
    updateMany: async ({ where, data }) => {
      for (const row of rows) if (row.objectKey === where.objectKey && row.previewStatus === where.previewStatus) Object.assign(row, data);
    },
  } };
  const service = new AttachmentPreviewsService(prisma, { ensureImagePreviews: async (key) => {
    started.push(key);
    await new Promise((resolve) => releases.set(key, resolve));
    return { ...imagePreviewKeys(key), previewStatus: 'ready' };
  } });
  const first = service.processBatch();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(started, ['a', 'b', 'c', 'd']);
  await service.processBatch();
  assert.equal(started.length, 4);
  releases.get('a')();
  await new Promise((resolve) => setImmediate(resolve));
  const refill = service.processBatch();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(started, ['a', 'b', 'c', 'd', 'e']);
  assert.equal(service.activeKeys.size, 4);
  releases.forEach((release) => release());
  await Promise.all([first, refill]);
  assert.ok(rows.every((row) => row.previewStatus === 'ready'));
  assert.equal(service.activeKeys.size, 0);
});

function storageMock({ failVariant = false, failOriginal = false } = {}) {
  const storage = new StorageService();
  const objects = new Map();
  const deleted = [];
  storage.internalClient = {
    putObject: async (bucket, key, body, size, metadata) => {
      if (failVariant && key.endsWith('.preview-v1.webp')) throw new Error('storage offline');
      if (failOriginal && !key.endsWith('.webp')) throw new Error('original write failed');
      const chunks = [];
      for await (const chunk of Buffer.isBuffer(body) ? [body] : body) chunks.push(chunk);
      objects.set(key, { body: Buffer.concat(chunks), size, metadata });
    },
    statObject: async (bucket, key) => {
      const object = objects.get(key);
      if (!object) throw new Error('missing');
      return { size: object.size, metaData: Object.fromEntries(Object.entries(object.metadata)
        .map(([name, value]) => [name.toLowerCase().replace(/^x-amz-meta-/, ''), value])) };
    },
    removeObjects: async (bucket, keys) => { deleted.push(...keys); keys.forEach((key) => objects.delete(key)); },
  };
  return { storage, objects, deleted };
}

test('upload preserves original bytes and exposes separate thumbnail and preview URLs', async () => {
  const { storage, objects } = storageMock();
  const buffer = await smallImage();
  const { key } = await storage.upload({ originalname: 'photo.png', mimetype: 'image/png', buffer });
  assert.deepEqual(objects.get(key).body, buffer);
  const service = new AttachmentsService({}, storage);
  const { create: [attachment] } = await service.buildCreateInput([key], 'attachment');
  const [serialized] = await service.serialize([{ id: 1, ...attachment }]);
  assert.equal(serialized.previewStatus, 'ready');
  assert.equal(serialized.size, buffer.length);
  assert.ok(serialized.thumbnailUrl.includes('.thumbnail-v1.webp'));
  assert.ok(serialized.previewUrl.includes('.preview-v1.webp'));
  assert.ok(!serialized.url.includes('.webp'));
});

test('variant storage failure preserves the original, removes partial previews and schedules retry', async () => {
  const { storage, objects } = storageMock({ failVariant: true });
  const buffer = await smallImage();
  const { key } = await storage.upload({ originalname: 'photo.png', mimetype: 'image/png', buffer });
  assert.deepEqual(objects.get(key).body, buffer);
  assert.equal(objects.size, 1);
  assert.equal((await storage.stat(key)).previews.previewStatus, 'pending');
});

test('corrupt images, PDF and DNG keep their originals without fallback preview URLs', async () => {
  for (const [originalname, mimetype] of [['broken.jpg', 'image/jpeg'], ['file.pdf', 'application/pdf'], ['file.dng', 'image/dng']]) {
    const { storage, objects } = storageMock();
    const buffer = Buffer.from('broken');
    const { key } = await storage.upload({ originalname, mimetype, buffer });
    assert.deepEqual(objects.get(key).body, buffer);
    const { previews } = await storage.stat(key);
    assert.equal(previews.previewStatus, 'unavailable');
    assert.equal(previews.thumbnailKey, null);
    assert.equal(previews.previewKey, null);
  }
});

test('an original upload failure cleans up its variants', async () => {
  const { storage, objects } = storageMock({ failOriginal: true });
  await assert.rejects(storage.upload({ originalname: 'photo.png', mimetype: 'image/png', buffer: await smallImage() }), /original write failed/);
  assert.equal(objects.size, 0);
});

test('deleting an original also removes both variants', async () => {
  const { storage, deleted } = storageMock();
  await storage.removeObjects(['file.jpg', 'file.jpg']);
  assert.deepEqual(deleted, ['file.jpg', ...Object.values(imagePreviewKeys('file.jpg'))]);
});

test('backfill renders an old attachment from disk and removes the temporary file', async () => {
  const { storage } = storageMock();
  storage.stat = async () => ({ size: 123, mimeType: 'image/png', previews: { previewStatus: 'pending' } });
  let source;
  storage.downloadToFile = async (key, destination) => { source = destination; await writeFile(destination, await smallImage()); };
  assert.equal((await storage.ensureImagePreviews('old.png')).previewStatus, 'ready');
  await assert.rejects(access(source));
  await assert.rejects(access(dirname(source)));
});

test('a failed download also cleans up its partial temporary original', async () => {
  const { storage } = storageMock();
  storage.stat = async () => ({ size: 123, mimeType: 'image/png', previews: { previewStatus: 'pending' } });
  let source;
  storage.downloadToFile = async (key, destination) => {
    source = destination;
    await writeFile(destination, 'partial download');
    throw new Error('offline');
  };
  await assert.rejects(storage.ensureImagePreviews('old.png'), /offline/);
  await assert.rejects(access(dirname(source)));
});

test('backfill persists ready states, does not overlap, and stops after three storage failures', async () => {
  const rows = [{ id: 1, objectKey: 'old.jpg', previewStatus: 'pending', previewAttempts: 0 }];
  let calls = 0;
  let fail = true;
  const writes = [];
  const service = new AttachmentPreviewsService({ attachment: {
    findMany: async () => rows.filter((row) => row.previewStatus === 'pending'),
    updateMany: async ({ where, data }) => {
      writes.push(data);
      for (const row of rows) if (row.previewStatus === where.previewStatus && (where.id ? row.id === where.id : row.objectKey === where.objectKey)) {
        if (data.previewAttempts) row.previewAttempts++;
        if (data.previewStatus) row.previewStatus = data.previewStatus;
      }
    },
  } }, { ensureImagePreviews: async () => {
    calls++;
    await new Promise((resolve) => setImmediate(resolve));
    if (fail) throw new Error('offline');
    return { ...imagePreviewKeys('old.jpg'), previewStatus: 'ready' };
  } });
  await Promise.all([service.processBatch(), service.processBatch()]);
  assert.equal(calls, 1);
  await service.processBatch();
  await service.processBatch();
  await service.processBatch();
  assert.equal(calls, 3);
  assert.equal(rows[0].previewStatus, 'failed');
  rows[0].previewStatus = 'pending';
  fail = false;
  await service.processBatch();
  assert.equal(rows[0].previewStatus, 'ready');
  assert.equal(writes.at(-1).thumbnailKey, 'old.jpg.thumbnail-v1.webp');
});
