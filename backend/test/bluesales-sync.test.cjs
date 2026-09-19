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
