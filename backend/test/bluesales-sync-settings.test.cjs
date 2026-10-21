// Run after npm run build: node --test test/bluesales-sync-settings.test.cjs
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { ValidationPipe } = require('@nestjs/common');
const { BluesalesInboundSyncService } = require('../dist/bluesales/bluesales-inbound-sync');
const { DevMetricsController } = require('../dist/bluesales/dev-metrics.controller');
const { UpdateInboundSyncDto } = require('../dist/bluesales/dto/update-inbound-sync.dto');

function database(initial) {
  let row = initial;
  return { bluesalesSyncSettings: {
    upsert: async () => {
      row ??= { id: 1, inboundEnabled: true, updatedAt: new Date() };
      return { ...row };
    },
    update: async ({ data }) => {
      row = { ...row, ...data, updatedAt: new Date() };
      return { ...row };
    },
  } };
}

test('setting fails closed until loaded, defaults to enabled, and survives restart in both modes', async () => {
  const prisma = database();
  let settings = new BluesalesInboundSyncService(prisma);
  assert.equal(settings.enabled, false);
  await settings.onModuleInit();
  assert.equal(settings.enabled, true);
  for (const enabled of [false, true]) {
    const saved = await settings.setEnabled(enabled);
    assert.equal(saved.enabled, enabled);
    assert.ok(saved.updatedAt instanceof Date);
    settings = new BluesalesInboundSyncService(prisma);
    await settings.onModuleInit();
    assert.equal(settings.enabled, enabled);
    assert.deepEqual(await settings.getState(), saved);
  }
});

test('startup does not overwrite a saved pause or load the row twice', async (t) => {
  const prisma = database({ id: 1, inboundEnabled: false, updatedAt: new Date() });
  const upsert = t.mock.method(prisma.bluesalesSyncSettings, 'upsert');
  const settings = new BluesalesInboundSyncService(prisma);
  await Promise.all([settings.initialize(), settings.onModuleInit(), settings.getState()]);
  assert.equal(upsert.mock.callCount(), 1);
  assert.equal(settings.enabled, false);
});

test('failed reads block import and failed saves keep the confirmed state, allowing retries', async (t) => {
  const broken = new BluesalesInboundSyncService({ bluesalesSyncSettings: { upsert: async () => { throw new Error('offline'); } } });
  await assert.rejects(broken.initialize(), /offline/);
  assert.equal(broken.enabled, false);
  const prisma = database();
  const settings = new BluesalesInboundSyncService(prisma);
  await settings.initialize();
  const update = t.mock.method(prisma.bluesalesSyncSettings, 'update', async () => { throw new Error('offline'); });
  await assert.rejects(settings.setEnabled(false), /offline/);
  assert.equal(settings.enabled, true);
  update.mock.restore();
  await settings.setEnabled(false);
  assert.equal(settings.enabled, false);
});

test('concurrent admin writes execute in order and keep storage and runtime consistent', async () => {
  const prisma = database();
  const write = prisma.bluesalesSyncSettings.update;
  const calls = [];
  let release;
  const blocked = new Promise((resolve) => { release = resolve; });
  prisma.bluesalesSyncSettings.update = async (args) => {
    calls.push(args.data.inboundEnabled);
    if (!args.data.inboundEnabled) await blocked;
    return write(args);
  };
  const settings = new BluesalesInboundSyncService(prisma);
  await settings.initialize();
  const pause = settings.setEnabled(false);
  const resume = settings.setEnabled(true);
  await new Promise(setImmediate);
  assert.deepEqual(calls, [false]);
  release();
  assert.equal((await pause).enabled, false);
  assert.equal((await resume).enabled, true);
  const restarted = new BluesalesInboundSyncService(prisma);
  await restarted.initialize();
  assert.equal(restarted.enabled, settings.enabled);
});

test('inbound endpoints read and change the shared setting', async () => {
  const settings = new BluesalesInboundSyncService(database());
  const controller = new DevMetricsController({}, {}, settings);
  assert.equal((await controller.inboundSyncState()).enabled, true);
  assert.equal((await controller.updateInboundSync({ enabled: false })).enabled, false);
  assert.equal(settings.enabled, false);
});

test('endpoint accepts only actual boolean values, including false', async () => {
  const pipe = new ValidationPipe({ whitelist: true, transform: true });
  const metadata = { type: 'body', metatype: UpdateInboundSyncDto };
  for (const enabled of [true, false]) {
    assert.equal((await pipe.transform({ enabled }, metadata)).enabled, enabled);
  }
  for (const body of [{}, { enabled: 'false' }, { enabled: 'true' }, { enabled: 0 }, { enabled: 1 }, { enabled: null }]) {
    await assert.rejects(pipe.transform(body, metadata), { status: 400 });
  }
});
