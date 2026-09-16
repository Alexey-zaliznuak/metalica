// Run after npm run build: node --test test/bluesales-metrics.test.cjs
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Reflector } = require('@nestjs/core');
const { GUARDS_METADATA } = require('@nestjs/common/constants');
const { BluesalesApiService } = require('../dist/bluesales/bluesales-api.service');
const { BluesalesMetricsService } = require('../dist/bluesales/bluesales-metrics.service');
const { DevMetricsController } = require('../dist/bluesales/dev-metrics.controller');
const { RolesGuard } = require('../dist/auth/roles.guard');
const { JwtAuthGuard } = require('../dist/auth/jwt-auth.guard');
const { usagePeriodStart, usageDateKey, usageForecast, weightedSyncTime, HOUR_MS } = require('../dist/bluesales/bluesales-usage');

const at = (value) => new Date(`2026-09-15T${value}+03:00`);
const config = { get: (key, fallback) => ({ BLUESALES_LOGIN: 'test', BLUESALES_PASSWORD: 'test' })[key] ?? fallback };
const response = (body, status = 200) => ({ status, text: async () => JSON.stringify(body) });
function setup() {
  const records = [];
  const api = new BluesalesApiService(config, { recordSuccess: async (record) => records.push(record) });
  api.waitForRequestGap = async () => {};
  api.logger = { log() {}, debug() {}, error() {}, warn() {} };
  return { api, records };
}

test('period boundary is 01:00 Moscow, including the previous calendar day', () => {
  assert.equal(usageDateKey(usagePeriodStart(at('00:59:59.999'))), '2026-09-14');
  assert.equal(usageDateKey(usagePeriodStart(at('01:00:00'))), '2026-09-15');
  assert.equal(usagePeriodStart(at('23:59:59')).toISOString(), '2026-09-14T22:00:00.000Z');
});

test('successful requests persist timing and label, excluding queue waits', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: at('12:00:00') });
  const { api, records } = setup();
  api.waitIfPaused = async () => t.mock.timers.setTime(at('12:10:00').getTime());
  t.mock.method(global, 'fetch', async () => response({ orders: [] }));
  await api.send('orders.get', {}, { label: 'order-background-sync' });
  assert.equal(records.length, 1);
  assert.equal(records[0].label, 'order-background-sync');
  assert.equal(records[0].startedAt.getTime(), at('12:10:00').getTime());
  assert.ok(records[0].durationMs >= 0 && records[0].durationMs < 1000);
});

test('HTTP, API and malformed JSON errors do not count as successful usage', async (t) => {
  const { api, records } = setup();
  const responses = [response({}, 500), response({ isValid: false }), response({ error: 'bad' }), { status: 200, text: async () => 'not JSON' }];
  t.mock.method(global, 'fetch', async () => responses.shift());
  for (let i = 0; i < 4; i++) await assert.rejects(api.send('orders.updateMany', {}, 'interactive'));
  assert.deepEqual(records, []);
});

test('a retry records only the successful attempt and keeps the label', async (t) => {
  const { api, records } = setup();
  api.sleep = async () => {};
  let count = 0;
  t.mock.method(global, 'fetch', async () => ++count === 1
    ? response({ error: 'Уже выполняется одно или несколько других обращений к API' })
    : response({}));
  await api.send('orders.updateMany', {}, { priority: 'interactive', label: 'status-delivery' });
  assert.equal(count, 2);
  assert.equal(records.length, 1);
  assert.equal(records[0].label, 'status-delivery');
});

test('concurrent callers and paginated requests keep independent labels', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: at('12:00:00') });
  const { api, records } = setup();
  t.mock.method(global, 'fetch', async () => response({ count: 1, notReturnedCount: 0, orders: [{ id: 1 }] }));
  await Promise.all([
    api.withLabel('order-background-sync', () => api.getOrders()),
    api.withLabel('manual', () => api.getOrdersByIds([2], 'interactive')),
  ]);
  assert.equal(records.filter((row) => row.label === 'order-background-sync').length, 2);
  assert.equal(records.filter((row) => row.label === 'manual').length, 1);
  await api.withLabel('outer', () => api.send('orders.get', {}, { label: 'explicit' }));
  await api.send('orders.get');
  assert.equal(records[3].label, 'explicit');
  assert.equal(records[4].label, 'orders.get');
});

test('metrics persistence failure does not retry a successful external mutation', async (t) => {
  const { api } = setup();
  api.metrics.recordSuccess = async () => { throw new Error('database unavailable'); };
  const fetch = t.mock.method(global, 'fetch', async () => response({ ok: true }));
  assert.deepEqual(await api.send('orders.updateMany', {}, 'interactive'), { ok: true });
  assert.equal(fetch.mock.callCount(), 1);
});

test('stored request uses its start period even if completed after 01:00', async () => {
  let saved;
  const service = new BluesalesMetricsService({ bluesalesRequestMetric: { create: async ({ data }) => { saved = data; } } });
  await service.recordSuccess({ label: ' orders ', method: 'orders.get', durationMs: 1250.8, startedAt: at('00:59:59'), completedAt: at('01:00:01') });
  assert.equal(saved.durationMs, 1251);
  assert.equal(saved.label, 'orders');
  assert.equal(usageDateKey(saved.periodStart), '2026-09-14');
});

test('forecast estimates hour threshold, handles low usage and insufficient data', () => {
  const input = { now: at('12:00:00'), periodStart: at('01:00:00'), totalMs: 30 * 60_000, recentMs: 10 * 60_000, recentCount: 60, observedFrom: at('06:00:00') };
  const forecast = usageForecast(input);
  assert.equal(forecast.status, 'will-reach');
  assert.equal(forecast.reachesAt.getTime(), at('15:00:00').getTime());
  assert.equal(usageForecast({ ...input, recentMs: 1000 }).status, 'below-target');
  assert.equal(usageForecast({ ...input, recentCount: 2 }).status, 'insufficient-data');
  assert.equal(usageForecast({ ...input, totalMs: HOUR_MS }).status, 'reached');
  assert.equal(usageForecast({ ...input, now: new Date('2026-09-16T01:00:00+03:00') }).status, 'closed');
});

test('forecast accounts for night pause and midnight/morning slowdown', () => {
  assert.equal(weightedSyncTime(at('01:00:00').getTime(), at('06:00:00').getTime()), 0);
  assert.equal(weightedSyncTime(at('06:00:00').getTime(), at('09:00:00').getTime()), HOUR_MS);
  assert.equal(weightedSyncTime(at('21:00:00').getTime(), new Date('2026-09-16T00:00:00+03:00').getTime()), 3 * HOUR_MS);
  assert.equal(weightedSyncTime(at('00:00:00').getTime(), at('01:00:00').getTime()), HOUR_MS / 3);
  const forecast = usageForecast({ now: at('21:00:00'), periodStart: at('01:00:00'), totalMs: 50 * 60_000, recentMs: 10 * 60_000, recentCount: 60, observedFrom: at('06:00:00') });
  assert.equal(forecast.reachesAt.toISOString(), '2026-09-15T19:00:00.000Z'); // 22:00 МСК
});

test('overview rejects invalid and future dates before querying the database', async () => {
  const service = new BluesalesMetricsService({});
  for (const date of ['2026-02-30', 'garbage', '2026-09-16']) {
    await assert.rejects(service.overview(date, at('12:00:00')), { status: 400 });
  }
});

test('dev metrics require both authentication and ADMIN, even with metrics scope', () => {
  const guards = Reflect.getMetadata(GUARDS_METADATA, DevMetricsController);
  assert.deepEqual(guards, [JwtAuthGuard, RolesGuard]);
  const guard = new RolesGuard(new Reflector());
  for (const role of ['ADMIN', 'MANAGER', 'SKETCH_DESIGNER', undefined]) {
    const allowed = guard.canActivate({ getClass: () => DevMetricsController, getHandler: () => DevMetricsController.prototype.overview, switchToHttp: () => ({ getRequest: () => ({ user: { role, scopes: ['METRICS_VIEW'] } }) }) });
    assert.equal(Boolean(allowed), role === 'ADMIN');
  }
});
