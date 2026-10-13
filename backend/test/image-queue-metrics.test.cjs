// Run after npm run build: node --test test/image-queue-metrics.test.cjs
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Reflector } = require('@nestjs/core');
const { RolesGuard } = require('../dist/auth/roles.guard');
const { DevMetricsController } = require('../dist/bluesales/dev-metrics.controller');
const { ImageQueueMetricsService } = require('../dist/storage/image-queue-metrics.service');
const { imageQueueBacklog, completionSummary, imageQueueEstimate } = require('../dist/storage/image-queue-metrics');

test('durable and local queues overlap; unclaimed production callbacks do not inflate backlog', () => {
  assert.deepEqual(imageQueueBacklog(10, 12, 5, {
    preview: { waiting: 3, running: 2 }, production: { waiting: 3, running: 2 },
  }), { preview: { waiting: 8, running: 2 }, production: { waiting: 15, running: 2 } });
  assert.deepEqual(imageQueueBacklog(1, 0, 0, {
    preview: { waiting: 2, running: 2 }, production: { waiting: 0, running: 0 },
  }).preview, { waiting: 2, running: 2 });
  assert.deepEqual(imageQueueBacklog(0, 12, 1, {
    preview: { waiting: 0, running: 0 }, production: { waiting: 3, running: 1 },
  }).production, { waiting: 12, running: 1 });
});

test('failed jobs cannot inflate successful throughput', () => {
  assert.deepEqual(completionSummary([
    { kind: 'preview', durationMs: 100, completedAt: 10, success: true },
    { kind: 'preview', durationMs: 400, completedAt: 20, success: false },
    { kind: 'production', durationMs: 200, completedAt: 30, success: true },
  ], 'preview'), { completed: 1, durationMs: 100, lastCompletedAt: new Date(10) });
});

test('ETA requires enough fresh successes, respects observed throughput and shared capacity', () => {
  const input = { outstanding: 10, completed: 6, durationMs: 120_000, concurrency: 1, observedMs: 60_000, hasRecentLocalSuccess: true };
  assert.deepEqual(imageQueueEstimate(input), { completedLastHour: 6, averageDurationMs: 20_000, throughputPerMinute: 3, etaSeconds: 200 });
  assert.equal(imageQueueEstimate({ ...input, observedMs: 120_000 }).etaSeconds, 200);
  assert.equal(imageQueueEstimate({ ...input, observedMs: 240_000 }).etaSeconds, 400);
  assert.equal(imageQueueEstimate({ ...input, completed: 2 }).etaSeconds, null);
  assert.equal(imageQueueEstimate({ ...input, hasRecentLocalSuccess: false }).etaSeconds, null);
  assert.equal(imageQueueEstimate({ ...input, outstanding: 0, hasRecentLocalSuccess: false }).etaSeconds, 0);
});

function setup(now) {
  const saved = [];
  const removed = [];
  const raw = [];
  let measurements = [];
  const prisma = {
    $queryRaw: async (query) => { raw.push(query.join('')); return [{ status: 'pending', count: 5 }, { status: 'ready', count: 3 }]; },
    productionFile: { groupBy: async () => [{ status: 'pending', _count: { _all: 4 } }, { status: 'processing', _count: { _all: 2 } }] },
    imageQueueMetric: {
      create: async ({ data }) => { saved.push({ id: BigInt(saved.length + 1), ...data }); },
      deleteMany: async (query) => { removed.push(query); },
      findMany: async () => saved,
    },
  };
  const storage = {
    imageQueueSnapshot: () => ({ preview: { waiting: 0, running: 1 }, production: { waiting: 1, running: 1 } }),
    imageJobConfiguration: () => ({ total: 2, preview: 2, production: 2 }),
    imageQueueMeasurements: () => measurements,
  };
  const service = new ImageQueueMetricsService(prisma, storage);
  service.lastSampleAt = now - 20_000;
  service.logger = { warn() {} };
  return { service, saved, removed, raw, setMeasurements: (value) => { measurements = value; } };
}

test('samples persist distinct originals, interval completions once, and prune after seven days', async (t) => {
  const now = Date.parse('2026-10-13T12:00:00Z');
  t.mock.timers.enable({ apis: ['Date'], now });
  const ctx = setup(now);
  ctx.setMeasurements([{ kind: 'preview', success: true, completedAt: now - 1000, durationMs: 3000 }]);
  await ctx.service.sample();
  assert.match(ctx.raw[0], /COUNT\(DISTINCT "objectKey"\)/);
  assert.equal(ctx.saved[0].previewWaiting, 4);
  assert.equal(ctx.saved[0].productionWaiting, 5);
  assert.equal(ctx.saved[0].productionRunning, 1);
  assert.equal(ctx.saved[0].previewCompleted, 1);
  assert.equal(ctx.removed[0].where.sampledAt.lt.getTime(), now - 168 * 3_600_000);
  t.mock.timers.setTime(now + 20_000);
  await ctx.service.sample();
  assert.equal(ctx.saved[1].previewCompleted, 0);
  assert.equal(ctx.removed.length, 1);
});

test('overview includes live backlog and persisted history; rejects invalid range without querying', async () => {
  const now = Date.now();
  const ctx = setup(now);
  for (const hours of ['', '0', '-1', '169', 'abc', '1.5']) {
    await assert.rejects(ctx.service.overview(hours), { status: 400 });
  }
  assert.equal(ctx.raw.length, 0);
  await ctx.service.sample();
  const result = await ctx.service.overview('24');
  assert.equal(result.historyHours, 24);
  assert.equal(result.history.length, 2);
  assert.equal(result.preview.waiting, 4);
  assert.equal(result.production.waiting, 5);
  assert.equal(result.etaSeconds, null);
  assert.deepEqual(result.concurrency, { total: 2, preview: 2, production: 2, scope: 'process' });
  assert.equal(result.estimateAssumption, 'no_new_jobs');
  assert.doesNotThrow(() => JSON.stringify(result));
});

test('overview keeps one completion boundary while a concurrent sampler advances', async (t) => {
  const now = Date.parse('2026-10-13T12:00:00Z');
  t.mock.timers.enable({ apis: ['Date'], now });
  const ctx = setup(now);
  ctx.setMeasurements(Array.from({ length: 3 }, (_, i) => ({ kind: 'preview', success: true, completedAt: now - 1000 - i, durationMs: 3000 })));
  ctx.service.prisma.imageQueueMetric.findMany = async () => {
    ctx.service.lastSampleAt = now;
    return [];
  };
  const result = await ctx.service.overview('1', new Date(now));
  assert.equal(result.preview.completedLastHour, 3);
  assert.ok(result.preview.etaSeconds > 0);
});

test('failed persistence does not lose unsampled completions', async (t) => {
  const now = Date.parse('2026-10-13T12:00:00Z');
  t.mock.timers.enable({ apis: ['Date'], now });
  const ctx = setup(now);
  ctx.setMeasurements([{ kind: 'production', success: true, completedAt: now - 1000, durationMs: 6000 }]);
  const create = ctx.service.prisma.imageQueueMetric.create;
  ctx.service.prisma.imageQueueMetric.create = async () => { throw new Error('database unavailable'); };
  await ctx.service.sample();
  assert.equal(ctx.service.lastSampleAt, now - 20_000);
  ctx.service.prisma.imageQueueMetric.create = create;
  t.mock.timers.setTime(now + 20_000);
  await ctx.service.sample();
  assert.equal(ctx.saved[0].productionCompleted, 1);
});

test('queue metrics retain ADMIN authorization and controller forwards the requested range', async () => {
  const controller = new DevMetricsController({}, { overview: async (hours) => ({ hours }) });
  assert.deepEqual(await controller.imageQueue('1'), { hours: '1' });
  const guard = new RolesGuard(new Reflector());
  for (const role of ['ADMIN', 'MANAGER', 'PRODUCTION', undefined]) {
    const allowed = guard.canActivate({ getClass: () => DevMetricsController, getHandler: () => DevMetricsController.prototype.imageQueue,
      switchToHttp: () => ({ getRequest: () => ({ user: { role, scopes: ['METRICS_VIEW'] } }) }) });
    assert.equal(Boolean(allowed), role === 'ADMIN');
  }
});
