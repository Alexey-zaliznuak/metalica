const { test } = require('node:test');
const assert = require('node:assert/strict');
const { ProductionTaskMetricsService } = require('../dist/storage/production-task-metrics.service');
const { DevMetricsController } = require('../dist/bluesales/dev-metrics.controller');

const now = new Date('2026-10-21T12:30:00Z');
const sizes = ['30x40', '40x60', '60x80'];
const event = (overrides = {}) => ({ orderId: 10, orderNumber: '12345', attachmentId: 7,
  textSize: '30x40', reason: 'created', createdAt: new Date('2026-10-21T12:00:00Z'), ...overrides });
function setup(events) {
  let query;
  const prisma = { productionTaskEvent: {
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
