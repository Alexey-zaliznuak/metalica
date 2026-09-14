// Optional isolated PostgreSQL integration test. Set METRICS_TEST_DATABASE_URL.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { PrismaClient } = require('@prisma/client');
const { BluesalesMetricsService } = require('../dist/bluesales/bluesales-metrics.service');

test('PostgreSQL persists request metrics and aggregates exact period, labels, hours and history', { skip: !process.env.METRICS_TEST_DATABASE_URL }, async () => {
  const url = new URL(process.env.METRICS_TEST_DATABASE_URL);
  assert.equal(url.hostname, '127.0.0.1');
  assert.equal(url.pathname, '/metrics_test');
  const prisma = new PrismaClient({ datasources: { db: { url: url.toString() } } });
  const service = new BluesalesMetricsService(prisma);
  try {
    await prisma.bluesalesRequestMetric.deleteMany();
    for (const [time, label, durationMs] of [
      ['2026-09-15T00:59:59+03:00', 'order-background-sync', 9000],
      ['2026-09-15T06:00:00+03:00', 'order-background-sync', 1000],
      ['2026-09-15T06:30:00+03:00', 'order-background-sync', 3000],
      ['2026-09-15T07:00:00+03:00', 'lead-background-sync', 2000],
      ['2026-09-16T00:59:59+03:00', 'lead-background-sync', 4000],
      ['2026-09-16T01:00:00+03:00', 'order-background-sync', 5000],
    ]) {
      await service.recordSuccess({ startedAt: new Date(time), completedAt: new Date(new Date(time).getTime() + durationMs), durationMs, label, method: 'orders.get' });
    }
    // A fresh service reads stored data; there is no process-local accumulator.
    const overview = await new BluesalesMetricsService(prisma).overview('2026-09-15', new Date('2026-09-16T12:00:00+03:00'));
    assert.equal(overview.summary.totalMs, 10_000);
    assert.equal(overview.summary.count, 4);
    assert.equal(overview.summary.averageMs, 2500);
    assert.equal(overview.labels[0].label, 'lead-background-sync');
    assert.equal(overview.labels[0].durationMs, 6000);
    assert.equal(overview.labels[1].maxMs, 3000);
    assert.equal(overview.hourly[5].durationMs, 4000);
    assert.equal(overview.hourly[23].cumulativeMs, 10_000);
    assert.equal(overview.forecast.status, 'closed');
    assert.deepEqual(overview.history.map((row) => [row.date, row.durationMs]), [
      ['2026-09-16', 5000], ['2026-09-15', 10_000], ['2026-09-14', 9000],
    ]);
    const empty = await service.overview('2026-09-13', new Date('2026-09-16T12:00:00+03:00'));
    assert.equal(empty.summary.totalMs, 0);
    assert.equal(empty.summary.averageMs, 0);
    assert.deepEqual(empty.labels, []);
  } finally {
    await prisma.$disconnect();
  }
});
