// Run after npm run build: node --test test/bluesales-sync.test.cjs
const { test } = require('node:test');
const assert = require('node:assert/strict');
process.env.BLUESALES_SYNC_TIME_ZONE = 'Europe/Moscow';
const { getBluesalesSyncSchedule } = require('../dist/bluesales/bluesales-sync.schedule');
const { BluesalesSyncService } = require('../dist/bluesales/bluesales-sync.service');
const { BluesalesApiService, BluesalesSyncPausedError } = require('../dist/bluesales/bluesales-api.service');

const at = (time) => new Date(`2026-09-15T${time}+03:00`);
const config = { get: (key, fallback) => ({ BLUESALES_LOGIN: 'test', BLUESALES_PASSWORD: 'test' })[key] ?? fallback };
const forbidden = new Proxy({}, { get: (_, key) => () => assert.fail(`Unexpected call: ${String(key)}`) });

function syncService() {
  const service = new BluesalesSyncService({ isConfigured: true, withLabel: (_label, task) => task() }, forbidden, config, null, null);
  service.loopActive = true;
  service.logger = { log() {}, error() {}, debug() {} };
  return service;
}

test('Moscow schedule stops at 01:00 and resumes at 06:00, keeping daytime and slow modes', () => {
  for (const [time, phase, enabled, multiplier] of [
    ['00:59:59.999', 'night', true, 3],
    ['01:00:00', 'paused', false, 3],
    ['02:00:00', 'paused', false, 3],
    ['05:59:59.999', 'paused', false, 3],
    ['06:00:00', 'morning', true, 3],
    ['08:59:59', 'morning', true, 3],
    ['09:00:00', 'day', true, 1],
    ['20:59:59', 'day', true, 1],
    ['21:00:00', 'day', true, 1],
    ['23:59:59.999', 'day', true, 1],
    ['00:00:00', 'night', true, 3],
  ]) {
    const schedule = getBluesalesSyncSchedule(at(time));
    assert.equal(schedule.phase, phase, time);
    assert.equal(schedule.ordersEnabled, enabled, time);
    assert.equal(schedule.leadsEnabled, enabled, time);
    assert.equal(schedule.pauseMultiplier, multiplier, time);
  }
});

test('cron, direct and startup syncs do no work during the pause', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: at('02:00:00') });
  const service = syncService();
  await service.handleFastSync();
  await service.handleLeadSync();
  await service.handleRecentBackfill();
  assert.deepEqual(await service.runFastSync(), { orders: 0 });
  assert.deepEqual(await service.runLeadSync(), { leads: 0 });
  await service.runFullSync();
  assert.equal(await service.syncOrdersWindow(at('00:00:00'), at('02:00:00')), 0);
  assert.equal(await service.syncLeadsWindow(at('00:00:00'), at('02:00:00')), 0);
});

test('all continuous loops wait at night and resume after 06:00', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: at('02:00:00') });
  for (const [loop, batch] of [
    ['runRefreshLoop', 'refreshBatch'],
    ['runLeadsLoop', 'refreshLeadsBatch'],
    ['runSketchBackfillLoop', 'sketchBackfillBatch'],
  ]) {
    t.mock.timers.setTime(at('02:00:00').getTime());
    const service = syncService();
    let calls = 0;
    service[batch] = async () => { calls++; service.loopActive = false; return 0; };
    service.sleep = async () => {
      if (service.loopActive) {
        assert.equal(calls, 0);
        t.mock.timers.setTime(at('06:00:00').getTime());
      }
    };
    await service[loop]();
    assert.equal(calls, 1, loop);
  }
});

test('manual refresh stays queued until morning', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: at('02:00:00') });
  const service = syncService();
  const refreshed = [];
  service.pendingManualRefreshIds.add(42);
  service.refreshSingleOrder = async (id) => refreshed.push(id);
  service.sleep = async () => {
    assert.deepEqual(refreshed, []);
    assert.equal(service.pendingManualRefreshIds.has(42), true);
    t.mock.timers.setTime(at('06:00:00').getTime());
  };
  await service.pumpManualRefreshes();
  assert.deepEqual(refreshed, [42]);
});

test('an orders response arriving after 01:00 is not applied', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: at('00:59:59') });
  const service = syncService();
  service.api.getOrders = async () => {
    t.mock.timers.setTime(at('01:00:00').getTime());
    return [{ id: 1 }];
  };
  assert.deepEqual(await service.runFastSync(), { orders: 0 });
});

test('a leads response arriving after 01:00 is not applied', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: at('00:59:59') });
  const service = syncService();
  service.api.getCustomers = async () => {
    t.mock.timers.setTime(at('01:00:00').getTime());
    return [{ id: 1 }];
  };
  assert.deepEqual(await service.runLeadSync(), { leads: 0 });
});

test('order and lead incremental syncs use separate request labels', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: at('12:00:00') });
  const labels = [];
  const service = new BluesalesSyncService(
    { isConfigured: true, withLabel: (label, task) => { labels.push(label); return task(); } },
    forbidden,
    config,
    null,
    null,
  );
  service.logger = { log() {}, error() {}, debug() {} };
  service.runFastSync = async () => ({ orders: 0 });
  service.runLeadSync = async () => ({ leads: 0 });
  await service.handleFastSync();
  await service.handleLeadSync();
  assert.deepEqual(labels, ['fast-sync', 'lead-fast-sync']);
});

test('API blocks queued sync reads at the boundary and resumes at 06:00', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: at('00:59:59') });
  const api = new BluesalesApiService(config, { recordSuccess: async () => {} });
  api.waitForRequestGap = async () => t.mock.timers.setTime(at('01:00:00').getTime());
  const fetch = t.mock.method(global, 'fetch', async () => ({ status: 200, text: async () => '{}' }));
  await assert.rejects(api.getOrdersByIds([1]), BluesalesSyncPausedError);
  await assert.rejects(api.getCustomersByIds([1]), BluesalesSyncPausedError);
  await assert.rejects(api.getOrdersByIds([1], 'interactive', true), BluesalesSyncPausedError);
  assert.equal(fetch.mock.callCount(), 0);
  // Status-change verification is a user action, not an import/sync.
  assert.deepEqual(await api.getOrdersByIds([1], 'interactive'), []);
  assert.equal(fetch.mock.callCount(), 1);
  api.waitForRequestGap = async () => {};
  t.mock.timers.setTime(at('06:00:00').getTime());
  assert.deepEqual(await api.getOrdersByIds([1]), []);
  assert.equal(fetch.mock.callCount(), 2);
});

test('pagination cannot send a new page after 01:00', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: at('00:59:59') });
  const api = new BluesalesApiService(config, { recordSuccess: async () => {} });
  api.waitForRequestGap = async () => {};
  const fetch = t.mock.method(global, 'fetch', async () => {
    t.mock.timers.setTime(at('01:00:00').getTime());
    return { status: 200, text: async () => JSON.stringify({ count: 1, notReturnedCount: 10, orders: [{ id: 1 }] }) };
  });
  await assert.rejects(api.getOrders(), BluesalesSyncPausedError);
  assert.equal(fetch.mock.callCount(), 1);
});

test('local artist is sent to BS only when different, with no incoming assignment', async () => {
  for (const [name, remote, expected] of [
    ['Катя', 'Аня', 1], ['Катя', 'Катя', 0], ['Катя', '', 1],
    [null, 'Аня', 0], ['', 'Аня', 0], [' Катя ', ' Катя ', 0],
  ]) {
    const service = syncService();
    const writes = [];
    service.prisma = { order: { findUnique: async () => ({
      sketchDesigner: name === null ? null : { name },
      bluesalesInfo: { bsOrderId: 101 },
    }) } };
    service.getCrmArtistFieldId = async () => 9001;
    service.api.setOrderCustomField = async (...args) => writes.push(args);
    await service.syncOrderArtistToBluesales(7, {
      id: 101,
      customFields: [{ fieldId: 9001, fieldName: 'Художник СРМ', value: 'id-from-bs', valueAsText: remote }],
    });
    assert.equal(writes.length, expected);
    if (expected) assert.deepEqual(writes[0], [101, 9001, 'Катя', 'background']);
  }
});

test('artist sync uses field metadata and skips obsolete BS bindings', async () => {
  const service = syncService();
  const writes = [];
  service.prisma = { order: { findUnique: async () => ({
    sketchDesigner: { name: 'Катя' }, bluesalesInfo: { bsOrderId: 101 },
  }) } };
  service.api.setOrderCustomField = async (...args) => writes.push(args);
  await service.syncOrderArtistToBluesales(7, { id: 100, customFields: [] });
  assert.equal(writes.length, 0);
  await service.syncOrderArtistToBluesales(7, { id: 101, customFields: [{ fieldId: 123, fieldName: ' Художник СРМ ', valueAsText: 'Аня' }] });
  assert.deepEqual(writes[0], [101, 123, 'Катя', 'background']);
});

test('artist sync retries on subsequent passes without failing order import', async () => {
  const service = syncService();
  let attempts = 0;
  service.prisma = { order: { findUnique: async () => ({
    sketchDesigner: { name: 'Катя' }, bluesalesInfo: { bsOrderId: 101 },
  }) } };
  service.getCrmArtistFieldId = async () => 9001;
  service.api.setOrderCustomField = async () => { attempts++; throw new Error('BS unavailable'); };
  await service.syncOrderArtistToBluesales(7, { id: 101, customFields: [] });
  await service.syncOrderArtistToBluesales(7, { id: 101, customFields: [] });
  assert.equal(attempts, 2);
});

test('artist API write touches only the target custom field', async () => {
  const api = Object.create(BluesalesApiService.prototype);
  let call;
  api.send = async (...args) => { call = args; };
  await api.setOrderCustomField(101, 6265, 'Катя');
  assert.deepEqual(call, ['orders.updateMany', {
    ids: [101], customFields: [{ fieldId: 6265, value: 'Катя' }],
  }, 'background']);
});

test('CRM artist sync ignores the old dropdown and writes the new text field', async () => {
  const service = syncService();
  const writes = [];
  service.prisma = { order: { findUnique: async () => ({ sketchDesigner: { name: 'Полина Вишнякова' }, bluesalesInfo: { bsOrderId: 12836039 } }) } };
  service.api.setOrderCustomField = async (...args) => writes.push(args);
  await service.syncOrderArtistToBluesales(15133, { id: 12836039, customFields: [
    { fieldId: 6265, fieldName: 'Художник', valueAsText: 'Полина Вишнякова' },
    { fieldId: 9001, fieldName: 'Художник СРМ', value: '' },
  ] });
  assert.deepEqual(writes, [[12836039, 9001, 'Полина Вишнякова', 'background']]);
});

test('CRM artist sync never falls back to the old field ID', async () => {
  const service = syncService();
  service.prisma = { order: { findUnique: async () => ({ sketchDesigner: { name: 'Полина Вишнякова' }, bluesalesInfo: { bsOrderId: 101 } }) } };
  service.getCrmArtistFieldId = async () => null;
  service.api.setOrderCustomField = async () => assert.fail('must not write without new field ID');
  await service.syncOrderArtistToBluesales(7, { id: 101, customFields: [{ fieldId: 6265, fieldName: 'Художник', valueAsText: 'Полина' }] });
});

test('CRM artist field ID comes from configuration or cached database metadata', async () => {
  const service = syncService();
  service.config = { get: (key) => key === 'BLUESALES_CRM_ARTIST_FIELD_ID' ? '9001' : undefined };
  assert.equal(await service.getCrmArtistFieldId(), 9001);
  service.config = { get: () => undefined };
  let queries = 0;
  service.prisma = { $queryRaw: async () => { queries++; return [{ fieldId: '9002' }]; } };
  assert.equal(await service.getCrmArtistFieldId(), 9002);
  assert.equal(await service.getCrmArtistFieldId(), 9002);
  assert.equal(queries, 1);
});
