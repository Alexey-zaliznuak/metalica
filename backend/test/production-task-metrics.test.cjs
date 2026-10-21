const { test } = require('node:test');
const assert = require('node:assert/strict');
const { ProductionTaskMetricsService } = require('../dist/storage/production-task-metrics.service');
const { DevMetricsController } = require('../dist/bluesales/dev-metrics.controller');

const now = new Date('2026-10-21T12:30:00Z');
const sizes = ['30x40', '40x60', '60x80'];
const event = (overrides = {}) => ({ orderId: 10, orderNumber: '12345', attachmentId: 7,
  textSize: '30x40', reason: 'created', createdAt: new Date('2026-10-21T12:00:00Z'), ...overrides });
function setup(events, queue = []) {
  let query;
  const prisma = { $queryRaw: async () => queue, productionTaskEvent: {
    findMany: async (args) => {
      query = args;
      return events.filter((row) => row.createdAt >= args.where.createdAt.gte && row.createdAt <= args.where.createdAt.lte)
        .sort((a, b) => b.createdAt - a.createdAt);
    },
  } };
  return { service: new ProductionTaskMetricsService(prisma), query: () => query };
}

test('twelve new jobs mean four actual photos with one task per size; repeats stay separate', async () => {
  const events = [7, 8, 9, 10].flatMap((attachmentId) => sizes.map((textSize) => event({ attachmentId, textSize })));
  events.push(event({ reason: 'changed' }), event({ reason: 'changed' }), event({ reason: 'retry' }));
  const { service } = setup(events);
  const result = await service.overview(now);
  assert.deepEqual(result.totals, { newTasks: 12, newPhotos: 4, changedTasks: 2, retriedTasks: 1 });
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].completePhotoSets, 4);
  assert.deepEqual(result.rows[0].sizes, { '30x40': 4, '40x60': 4, '60x80': 4 });
  assert.equal(result.rows[0].photos[0].newTasks, 3);
  assert.equal(result.rows[0].photos[0].changedTasks, 2);
  assert.equal(result.rows[0].photos[0].retriedTasks, 1);
});

test('sliding last-hour bounds exclude older and future events, including a date boundary', async () => {
  const atMidnight = new Date('2026-10-20T21:30:00Z'); // 00:30 Moscow
  const from = new Date(atMidnight.getTime() - 3_600_000);
  const ctx = setup([
    event({ createdAt: new Date(from.getTime() - 1) }), event({ createdAt: from }),
    event({ createdAt: atMidnight }), event({ createdAt: new Date(atMidnight.getTime() + 1) }),
  ]);
  const result = await ctx.service.overview(atMidnight);
  assert.deepEqual(result.period, { from, to: atMidnight });
  assert.equal(result.totals.newTasks, 2);
  assert.equal(ctx.query().select.id, undefined, 'BigInt event IDs are not serialized to HTTP');
});

test('photo counts use IDs, not tasks divided by three; incomplete and duplicate size sets are visible', async () => {
  const events = [event(), event(), event(), event({ attachmentId: 8, textSize: '40x60' })];
  const { service } = setup(events);
  const result = await service.overview(now);
  assert.equal(result.rows[0].newTasks, 4);
  assert.equal(result.rows[0].newPhotos, 2);
  assert.equal(result.rows[0].completePhotoSets, 0);
  assert.equal(result.rows[0].photos[0].sizes['30x40'], 3);
});

test('groups by order ID, keeps latest order number, and includes orders with only repeated preparation', async () => {
  const ctx = setup([
    event(), event({ orderNumber: 'renamed', reason: 'changed', createdAt: new Date('2026-10-21T12:20:00Z') }),
    event({ orderId: 11, orderNumber: '12345', attachmentId: 9, reason: 'retry' }),
  ]);
  const result = await ctx.service.overview(now);
  assert.equal(result.rows.length, 2);
  assert.equal(result.rows[0].orderNumber, 'renamed');
  assert.equal(result.rows[1].newPhotos, 0);
  assert.equal(result.rows[1].retriedTasks, 1);
  assert.equal(result.rows[1].photos.length, 1);
  const empty = await setup([]).service.overview(now);
  assert.deepEqual(empty.rows, []);
  assert.deepEqual(empty.totals, { newTasks: 0, newPhotos: 0, changedTasks: 0, retriedTasks: 0 });
});

test('production debug endpoint returns the task journal overview', async () => {
  const service = setup([event()]).service;
  const controller = new DevMetricsController({}, {}, {}, { overview: () => service.overview(now) });
  assert.equal((await controller.productionDebug()).totals.newTasks, 1);
});

test('journal cleanup keeps the full seven-day retention window', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now });
  let cutoff;
  const service = new ProductionTaskMetricsService({ productionTaskEvent: {
    deleteMany: async ({ where }) => { cutoff = where.createdAt.lt; },
  } });
  await service.prune();
  assert.equal(cutoff.getTime(), now.getTime() - 7 * 24 * 3_600_000);
});

test('current queue includes old tasks, assigns one category per task and preserves original retry cause', async () => {
  const base = { id: 1, orderId: 10, orderNumber: '12345', attachmentId: 7, textSize: '30x40', status: 'pending',
    attempts: 0, error: null, cause: 'new_attachment', queuedAt: new Date('2026-10-20T10:00:00Z'),
    createdAt: new Date('2026-10-19T10:00:00Z'), nextAttemptAt: now, leaseUntil: null, trigger: 'attachment_added', changes: [] };
  const jobs = [base,
    { ...base, id: 2, textSize: '40x60', cause: 'data_change', attempts: 1, error: 'Storage unavailable' },
    { ...base, id: 3, textSize: '60x80', cause: null, queuedAt: null, changes: null },
    { ...base, id: 4, orderId: 11, attachmentId: 8, cause: 'backfill', status: 'processing', attempts: 2, leaseUntil: new Date(now.getTime()-1) },
  ];
  const result = await setup([], jobs).service.overview(now);
  assert.deepEqual(result.totals, { newTasks: 0, newPhotos: 0, changedTasks: 0, retriedTasks: 0 });
  assert.equal(result.queue.total, 4);
  assert.equal(result.queue.pending + result.queue.processing, result.queue.total);
  assert.equal(result.queue.causes.reduce((sum, row) => sum + row.count, 0), result.queue.total);
  assert.deepEqual(result.queue.rows.map((row) => row.category), ['new_attachment', 'automatic_retry', 'legacy_unknown', 'backfill']);
  assert.equal(result.queue.rows[1].cause, 'data_change');
  assert.equal(result.queue.rows[1].error, 'Storage unavailable');
  assert.equal(result.queue.rows[3].leaseExpired, true);
  assert.equal(result.queue.photos, 2);
  assert.equal(result.queue.orders, 2);
});

test('per-photo journal exposes exact changes and distinguishes missing old history from an empty diff', async () => {
  const changes = [{ field: 'comment', before: 'Матовая', after: 'Глянцевая' }];
  const result = await setup([
    event({ reason: 'changed', cause: 'data_change', trigger: 'background_scan', changes }),
    event({ reason: 'changed', cause: null, trigger: null, changes: null }),
  ]).service.overview(now);
  const history = result.rows[0].photos[0].events;
  assert.deepEqual(history[0].changes, changes);
  assert.equal(history[0].trigger, 'background_scan');
  assert.equal(history[1].changes, null);
});
