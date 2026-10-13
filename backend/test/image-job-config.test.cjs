// Run after npm run build: node --test test/image-job-config.test.cjs
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { imageJobConfiguration } = require('../dist/storage/image-job.config');
const { ImagePreviewQueue } = require('../dist/storage/image-preview');
const { StorageService } = require('../dist/storage/storage.service');
const { ProductionFilesService } = require('../dist/orders/production-files.service');
const { AttachmentPreviewsService } = require('../dist/storage/attachment-previews.service');

const names = ['IMAGE_JOB_CONCURRENCY', 'IMAGE_PREVIEW_CONCURRENCY', 'PRODUCTION_IMAGE_CONCURRENCY'];
function withEnv(values, operation) {
  const previous = names.map((name) => process.env[name]);
  try {
    for (const name of names) {
      if (values[name] === undefined) delete process.env[name];
      else process.env[name] = values[name];
    }
    return operation();
  } finally {
    names.forEach((name, index) => {
      if (previous[index] === undefined) delete process.env[name];
      else process.env[name] = previous[index];
    });
  }
}

test('configuration defaults to four shared slots and reads env at construction after module import', () => {
  withEnv({}, () => assert.deepEqual(imageJobConfiguration(), { total: 4, preview: 4, production: 4 }));
  withEnv({ IMAGE_JOB_CONCURRENCY: '6', IMAGE_PREVIEW_CONCURRENCY: '2', PRODUCTION_IMAGE_CONCURRENCY: '3' }, () => {
    assert.deepEqual(imageJobConfiguration(), { total: 6, preview: 2, production: 3 });
    const storage = new StorageService();
    assert.deepEqual(storage.imageJobConfiguration(), { total: 6, preview: 2, production: 3 });
    assert.equal(storage.previewQueue.concurrency, 6);
    assert.equal(storage.previewQueue.limits.preview, 2);
    assert.equal(storage.previewQueue.limits.production, 3);
    assert.equal(new ProductionFilesService({}, storage, {}).concurrency, 3);
    assert.equal(new AttachmentPreviewsService({}, storage).concurrency, 2);
  });
});

test('kind limits are capped by the shared budget and empty env values use defaults', () => {
  withEnv({ IMAGE_JOB_CONCURRENCY: '2', IMAGE_PREVIEW_CONCURRENCY: '8', PRODUCTION_IMAGE_CONCURRENCY: '' }, () => {
    assert.deepEqual(imageJobConfiguration(), { total: 2, preview: 2, production: 2 });
  });
});

test('invalid concurrency values fail early with the offending env parameter', () => {
  for (const name of names) for (const value of ['0', '-1', '1.5', 'abc', 'Infinity', '9007199254740992', ' ']) {
    withEnv({ [name]: value }, () => assert.throws(imageJobConfiguration, new RegExp(`${name} must be a positive integer`)));
  }
  for (const value of [0, -1, 1.5, NaN]) {
    assert.throws(() => new ImagePreviewQueue(value), /Invalid image concurrency/);
    assert.throws(() => new ImagePreviewQueue(2, { preview: value, production: 1 }), /Invalid image kind concurrency/);
  }
});

test('storage metrics omit idle production dispatches and record rendered success and failure', async () => {
  const storage = withEnv({ IMAGE_JOB_CONCURRENCY: '1' }, () => new StorageService());
  await storage.runImageJob(async () => undefined);
  assert.deepEqual(storage.imageQueueMeasurements(), []);
  await storage.runImageJob(async () => true);
  await storage.runImageJob(async () => false);
  assert.deepEqual(storage.imageQueueMeasurements().map(({ kind, success }) => ({ kind, success })), [
    { kind: 'production', success: true }, { kind: 'production', success: false },
  ]);
});
