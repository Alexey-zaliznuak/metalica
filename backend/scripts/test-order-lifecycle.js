require('ts-node/register/transpile-only');
const assert = require('node:assert/strict');
const { lifecycleEligible, LIFECYCLE_STATUSES: s } = require('../src/orders/order-lifecycle.policy');
const payload = value => ({ customFields: [{ fieldName: 'Дедлайн отправки', value }] });
const now = new Date('2026-11-04T10:00:00Z');
assert.equal(lifecycleEligible(s.ready, payload('03.09.2026'), now), true);
assert.equal(lifecycleEligible(s.ready, payload('04.09.2026'), now), false);
assert.equal(lifecycleEligible(s.ready, payload('2026-09-03'), now), true);
assert.equal(lifecycleEligible(s.ready, payload('31.02.2026'), now), false);
assert.equal(lifecycleEligible(174704, payload('01.01.2026'), now), false);
assert.equal(lifecycleEligible(s.cancelled, payload('01.01.2026'), now), true);
assert.equal(lifecycleEligible(s.cancelled, payload('01.01.2026'), now, true), false);
assert.equal(lifecycleEligible(s.awaitingReceipt, payload('01.01.2026'), now, true), false);
assert.equal(lifecycleEligible(s.delivered, payload('01.01.2026'), now, true), true);
assert.equal(lifecycleEligible(s.ready, payload('2026-02-28'), new Date('2026-04-30T10:00:00Z')), false);
assert.equal(lifecycleEligible(s.ready, payload('2026-02-27'), new Date('2026-04-30T10:00:00Z')), true);
assert.equal(lifecycleEligible(s.ready, {}, now), false);
console.log('Lifecycle policy: 12 assertions passed');

const { OrderLifecycleService } = require('../src/orders/order-lifecycle.service');
const { CLEANUP_TAG, COMPLETE_TAG } = require('../src/orders/order-lifecycle.policy');
(async () => {
  const calls = [];
  const info = { orderId: 1, orderStatusId: s.ready, rawPayload: payload('01.01.2020') };
  const db = {
    $queryRaw: async () => [],
    bluesalesOrderInfo: { findMany: async q => { assert.equal(q.take, 100); return [{ orderId: 1 }]; }, findUnique: async () => info },
    orderSystemTag: { upsert: async q => calls.push(['mark', q]), deleteMany: async () => {},
      findMany: async q => { calls.push(['actions', q]); return []; } },
  };
  db.$transaction = fn => fn(db);
  const service = new OrderLifecycleService(db, {}, {}, {});
  await service.tick(CLEANUP_TAG, false);
  assert.equal(calls.filter(c => c[0] === 'mark').length, 1, 'disabled action still marks orders');
  assert.equal(calls.filter(c => c[0] === 'actions').length, 0, 'disabled action never fetches deletion work');
  await service.tick(CLEANUP_TAG, true);
  const query = calls.find(c => c[0] === 'actions')[1];
  assert.equal(query.take, 100);
  assert.equal(query.where.completedAt, null);
  assert.ok(Math.abs(Date.now() - query.where.markedAt.lt.getTime() - 7 * 86400000) < 5000);
  await service.tick(COMPLETE_TAG, false);
  assert.equal(calls.filter(c => c[0] === 'mark').at(-1)[1].create.kind, COMPLETE_TAG);
  const previousMarked = new Date('2020-01-01');
  db.orderSystemTag.upsert = async () => ({ id: 5, markedAt: previousMarked, completedAt: new Date('2020-01-09') });
  db.orderSystemTag.update = async q => calls.push(['rearm', q]);
  db.attachment = { count: async () => 1 };
  db.orderEvent = { create: async q => calls.push(['audit', q]) };
  await service.tick(CLEANUP_TAG, false);
  const rearm = calls.find(c => c[0] === 'rearm')[1];
  assert.equal(rearm.data.completedAt, null);
  assert.ok(Math.abs(rearm.data.markedAt.getTime() - Date.now()) < 5000);
  assert.equal(calls.find(c => c[0] === 'audit')[1].data.oldValue, previousMarked.toISOString());
  console.log('Lifecycle workers: disabled marking, enabled grace period, batching passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
