// Run after npm run build: node --test test/bluesales-inbound-sync.test.cjs
const { test } = require('node:test');
const assert = require('node:assert/strict');
process.env.BLUESALES_SYNC_TIME_ZONE = 'Europe/Moscow';
const { BluesalesInboundSyncService } = require('../dist/bluesales/bluesales-inbound-sync');
const { BluesalesSyncService } = require('../dist/bluesales/bluesales-sync.service');
const { BluesalesApiService, BluesalesSyncPausedError } = require('../dist/bluesales/bluesales-api.service');
const { OrderStatusOutboxProcessor } = require('../dist/orders/order-status-outbox.processor');
const { OrdersService } = require('../dist/orders/orders.service');

const noon = new Date('2026-10-11T12:00:00+03:00');
const silent = { log() {}, warn() {}, error() {}, debug() {} };
const forbidden = new Proxy({}, { get: (_, key) => () => assert.fail(`Unexpected call: ${String(key)}`) });
function configuration() {
  const values = { BLUESALES_LOGIN: 'test', BLUESALES_PASSWORD: 'test' };
  return { values, get: (key, fallback) => values[key] ?? fallback };
}
function syncService(inboundSync) {
  const service = new BluesalesSyncService(forbidden, forbidden, configuration(), forbidden, forbidden, inboundSync);
  service.logger = silent;
  return service;
}

async function persistedSetting(enabled) {
  const prisma = { bluesalesSyncSettings: {
    upsert: async () => ({ inboundEnabled: enabled, updatedAt: noon }),
    update: async ({ data }) => ({ inboundEnabled: enabled = data.inboundEnabled, updatedAt: noon }),
  } };
  const settings = new BluesalesInboundSyncService(prisma);
  await settings.initialize();
  return settings;
}

test('startup with saved pause keeps refresh loops available without launching full import', async (t) => {
  const settings = await persistedSetting(false);
  const service = syncService(settings);
  service.api = { isConfigured: true, withLabel: (_label, task) => task() };
  service.fullSyncOnStartup = true;
  const scheduled = [];
  t.mock.method(global, 'setTimeout', (callback, ms) => { scheduled.push({ callback, ms }); return 1; });
  const calls = [];
  for (const loop of ['runRefreshLoop', 'runLeadsLoop', 'runSketchBackfillLoop']) {
    service[loop] = async () => { calls.push(loop); };
  }
  service.runFullSync = async () => assert.fail('Full import must not be scheduled while disabled');
  await service.onModuleInit();
  assert.equal(service.loopActive, true);
  assert.equal(service.canRefreshFromBluesales, false);
  assert.deepEqual(scheduled.map(({ ms }) => ms), [5000, 8000, 6000]);
  await settings.setEnabled(true);
  assert.equal(service.canRefreshFromBluesales, true);
  scheduled.forEach(({ callback }) => callback());
  assert.deepEqual(calls, ['runRefreshLoop', 'runLeadsLoop', 'runSketchBackfillLoop']);
  service.onModuleDestroy();
});

test('paused continuous loops resume on admin change without restarting the service', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: noon });
  for (const [loop, batch] of [
    ['runRefreshLoop', 'refreshBatch'], ['runLeadsLoop', 'refreshLeadsBatch'],
    ['runSketchBackfillLoop', 'sketchBackfillBatch'],
  ]) {
    const settings = await persistedSetting(false);
    const service = syncService(settings);
    service.loopActive = true;
    let calls = 0;
    service[batch] = async () => { calls++; service.loopActive = false; return 0; };
    service.sleep = async () => { if (service.loopActive) await settings.setEnabled(true); };
    await service[loop]();
    assert.equal(calls, 1, loop);
  }
});

test('pause during local lookup prevents lead and order writes from an already received response', async () => {
  const settings = await persistedSetting(true);
  const service = syncService(settings);
  service.prisma = { lead: {
    findUnique: async () => { await settings.setEnabled(false); return null; },
    upsert: async () => assert.fail('Lead must not be overwritten'),
  } };
  assert.equal(await service.upsertLead({ id: 1, fullName: 'Remote' }, false), null);
  await settings.setEnabled(true);
  service.isClosesSketchStatus = async () => false;
  service.resolveSketchTimestampUpdate = async () => ({});
  service.syncOrderArtistToBluesales = async () => {};
  const tx = {
    $queryRaw: async () => { await settings.setEnabled(false); },
    bluesalesOrderInfo: { findUnique: async () => null, update: async () => assert.fail('Order must not be overwritten') },
    orderStatusChange: { count: async () => 0 },
    order: { findUnique: async () => ({ orderNumber: '1' }), update: async () => assert.fail('Order must not be overwritten') },
  };
  service.prisma = { $transaction: async (task) => task(tx) };
  await service.upsertOrder({ id: 1 }, null, { orderId: 7 });
});

test('disabled import blocks cron, direct syncs and persistence without API or DB access', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: noon });
  const service = syncService({ enabled: false, initialize: async () => {} });
  assert.equal(service.canRefreshFromBluesales, false);
  await service.handleFastSync();
  await service.handleLeadSync();
  await service.handleRecentBackfill();
  assert.deepEqual(await service.runFastSync(), { orders: 0 });
  assert.deepEqual(await service.runLeadSync(), { leads: 0 });
  assert.deepEqual(await service.runRecentBackfill(), { orders: 0, leads: 0 });
  await service.runFullSync();
  assert.equal(await service.syncOrdersWindow(noon, noon), 0);
  assert.equal(await service.syncLeadsWindow(noon, noon), 0);
  await service.refreshBatch();
  await service.refreshLeadsBatch();
  await service.refreshSingleOrder(7);
  assert.equal(await service.upsertLeads([{ id: 1 }]), 0);
  assert.equal(await service.upsertLead({ id: 1, fullName: 'Remote', crmStatus: { name: 'Old' } }), null);
  await service.upsertOrder({ id: 1, orderStatus: { id: 2, name: 'Old' } }, 1);
  await service.syncReferenceDictionaries([{ id: 1, tags: [{ id: 2, name: 'Remote' }] }]);
  await service.upsertSourceName({ bsSourceId: '1', name: 'Remote' });
  await service.upsertSalesChannelName({ bsSalesChannelId: '1', name: 'Remote' });
  await service.upsertTags([{ bsTagId: '1', name: 'Remote' }]);
});

test('disabled import rejects refresh from the order endpoint and clears queued manual refreshes', async () => {
  const service = syncService({ enabled: false, initialize: async () => {} });
  assert.throws(() => service.enqueueOrderRefresh(7), /синхронизация BlueSales отключена/);
  assert.equal(service.pendingManualRefreshIds.size, 0);
  service.pendingManualRefreshIds.add(7);
  await service.pumpManualRefreshes();
  assert.equal(service.pendingManualRefreshIds.size, 0);
  const orders = Object.create(OrdersService.prototype);
  orders.bsSync = service;
  orders.prisma = { order: { findUnique: async () => ({ id: 7, source: 'BLUESALES', bluesalesInfo: { bsOrderId: 1 } }) } };
  await assert.rejects(orders.requestBluesalesRefresh(7), /Синхронизация BlueSales отключена/);
});

test('continuous order, lead and sketch loops cannot import while disabled', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: noon });
  for (const [loop, batch] of [
    ['runRefreshLoop', 'refreshBatch'],
    ['runLeadsLoop', 'refreshLeadsBatch'],
    ['runSketchBackfillLoop', 'sketchBackfillBatch'],
  ]) {
    const service = syncService({ enabled: false, initialize: async () => {} });
    service.loopActive = true;
    service[batch] = async () => assert.fail(`Unexpected ${batch}`);
    service.sleep = async () => { service.loopActive = false; };
    await service[loop]();
  }
});

test('responses that arrive after import is disabled cannot reach CRM writes', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: noon });
  for (const path of ['runFastSync', 'runLeadSync', 'syncOrdersWindow', 'syncLeadsWindow', 'refreshSingleOrder']) {
    const inboundSync = { enabled: true };
    const service = syncService(inboundSync);
    const respond = async () => {
      inboundSync.enabled = false;
      return [{ id: 1, customer: { id: 2 }, orderStatus: { id: 3, name: 'Old' } }];
    };
    service.api = { getOrders: respond, getCustomers: respond, getOrdersByIds: respond };
    if (path === 'refreshSingleOrder') {
      service.prisma = { bluesalesOrderInfo: { findUnique: async () => ({ bsOrderId: 1, orderId: 7 }) } };
    }
    await service[path](noon, noon);
    assert.equal(service.pendingManualRefreshIds.size, 0, path);
  }
});

test('API stops queued import reads, while outgoing writes and delivery verification remain available', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: noon });
  const inboundSync = { enabled: true };
  const api = new BluesalesApiService(configuration(), { recordSuccess: async () => {} }, inboundSync);
  api.logger = silent;
  // The switch changes while the request is waiting for its turn.
  api.waitForRequestGap = async () => { inboundSync.enabled = false; };
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    calls.push(new URL(url).searchParams.get('command'));
    return { status: 200, text: async () => JSON.stringify({ orders: [{ id: 1, orderStatus: { id: 7 } }] }) };
  });
  await assert.rejects(api.getOrdersByIds([1]), BluesalesSyncPausedError);
  await assert.rejects(api.getCustomersByIds([1]), BluesalesSyncPausedError);
  await assert.rejects(api.getOrders(), BluesalesSyncPausedError);
  await assert.rejects(api.getCustomers(), BluesalesSyncPausedError);
  await assert.rejects(api.getOrdersByIds([1], 'interactive', true), BluesalesSyncPausedError);
  assert.deepEqual(calls, []);
  api.unblock();
  await assert.rejects(api.getOrdersByIds([1]), BluesalesSyncPausedError);
  await api.setOrdersStatus([1], 7);
  assert.equal((await api.getOrdersByIds([1], 'interactive'))[0].orderStatus.id, 7);
  assert.deepEqual(calls, ['orders.updateMany', 'orders.get']);
});

test('outbox delivers and acknowledges a local status without importing remote fields in disabled mode', async () => {
  const calls = [];
  let remoteStatus = 2;
  const change = { id: 1, orderId: 7, toStatusId: 8, toStatusName: 'Local', attempts: 0, leaseToken: 'lease', verifyFirst: false };
  const tx = {
    orderStatusChange: {
      updateMany: async ({ data }) => { calls.push(['state', data.state]); return { count: 1 }; },
      count: async () => 0,
    },
    bluesalesOrderInfo: { updateMany: async () => assert.fail('Remote data must not overwrite the local status') },
  };
  const prisma = {
    bluesalesOrderInfo: { findMany: async () => [{ orderId: 7, bsOrderId: 101 }] },
    orderStatusChange: { updateMany: async () => ({ count: 1 }) },
    $transaction: async (task) => task(tx),
  };
  const api = {
    withLabel: (_label, task) => task(),
    setOrdersStatus: async (ids, status) => { calls.push(['write', ids, status]); remoteStatus = status; },
    getOrdersByIds: async (ids) => {
      calls.push(['read', ids]);
      return [{ id: 101, orderStatus: { id: remoteStatus, name: 'Remote name' }, customer: { fullName: 'Remote customer' } }];
    },
  };
  const service = new OrderStatusOutboxProcessor(prisma, api, configuration(), { enabled: false });
  service.logger = silent;
  await service.deliverBatch([change]);
  assert.deepEqual(calls, [['write', [101], 8], ['read', [101]], ['state', 'SUCCEEDED']]);
});

test('enabling import restores normal sync and outbox reconciliation', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: noon });
  const inboundSync = { enabled: true };
  const service = syncService(inboundSync);
  const imported = [];
  service.api = { isConfigured: true, getOrders: async () => [{ id: 101, customer: { id: 1 } }] };
  service.prisma = { bluesalesOrderInfo: { findMany: async () => [] } };
  service.syncReferenceDictionaries = async () => {};
  service.upsertLead = async () => 1;
  service.upsertOrder = async (order, leadId) => imported.push([order.id, leadId]);
  service.syncOrderArtistsToBluesales = async () => {};
  assert.equal(service.canRefreshFromBluesales, true);
  assert.deepEqual(await service.runFastSync(), { orders: 1 });
  assert.deepEqual(imported, [[101, 1]]);
  let saved;
  const tx = {
    orderStatusChange: { updateMany: async () => ({ count: 1 }), count: async () => 0 },
    bluesalesOrderInfo: { updateMany: async ({ data }) => { saved = data; } },
  };
  const outbox = new OrderStatusOutboxProcessor({ $transaction: async (task) => task(tx) }, {}, configuration(), inboundSync);
  outbox.logger = silent;
  await outbox.completeChange({ id: 1, orderId: 7, toStatusId: 8, toStatusName: 'Local', leaseToken: 'lease' },
    { id: 101, orderStatus: { id: 8, name: 'Remote name' } }, noon);
  assert.equal(saved.orderStatusId, 8);
  assert.equal(saved.orderStatus, 'Remote name');
});
