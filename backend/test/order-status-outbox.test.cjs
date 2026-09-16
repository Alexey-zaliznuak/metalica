// Run after npm run build; isolated PostgreSQL via OUTBOX_TEST_DATABASE_URL.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { PrismaClient } = require('@prisma/client');
const { OrderStatusOutboxProcessor } = require('../dist/orders/order-status-outbox.processor');
const { BluesalesApiService } = require('../dist/bluesales/bluesales-api.service');

const silent = { log() {}, warn() {}, error() {} };
test('status API sends a deduplicated batch with one target status and enforces its limit', async () => {
  const api = Object.create(BluesalesApiService.prototype);
  api.logger = silent;
  const calls = [];
  api.send = async (...args) => { calls.push(args); return {}; };
  await api.setOrdersStatus([1, 2, 2], 7);
  await api.setOrderStatus(3, 8);
  await api.setOrdersStatus([], 7);
  assert.deepEqual(calls, [
    ['orders.updateMany', { ids: [1, 2], orderStatus: { id: 7 } }, 'interactive'],
    ['orders.updateMany', { ids: [3], orderStatus: { id: 8 } }, 'interactive'],
  ]);
  await assert.rejects(api.setOrdersStatus(Array.from({ length: 501 }, (_, i) => i), 7));
  assert.equal(calls.length, 2);
});

test('durable batched status delivery in PostgreSQL', { skip: !process.env.OUTBOX_TEST_DATABASE_URL }, async (t) => {
  const url = new URL(process.env.OUTBOX_TEST_DATABASE_URL);
  assert.equal(url.hostname, '127.0.0.1');
  assert.equal(url.pathname, '/outbox_test');
  const prisma = new PrismaClient({ datasources: { db: { url: url.toString() } } });
  const config = { get: () => undefined };
  let states, calls, service, api, onRead, onWrite;
  const reset = async () => {
    await prisma.order.deleteMany();
    states = new Map(); calls = []; onRead = null; onWrite = null;
    api = {
      withLabel: async (label, task) => { calls.push(['label', label]); return task(); },
      setOrdersStatus: async (ids, status) => {
        calls.push(['write', ids, status]);
        if (onWrite) return onWrite(ids, status);
        ids.forEach((id) => states.set(id, status));
      },
      getOrdersByIds: async (ids) => {
        calls.push(['read', ids]);
        if (onRead) return onRead(ids);
        return ids.filter((id) => states.has(id)).map((id) => ({ id, orderStatus: { id: states.get(id), name: 'Status' } }));
      },
    };
    service = new OrderStatusOutboxProcessor(prisma, api, config);
    service.logger = silent;
  };
  const make = async (bsId, status = 7, extra = {}) => {
    let order = await prisma.order.findUnique({ where: { orderNumber: `test-${bsId}` } });
    if (!order) order = await prisma.order.create({ data: {
      orderNumber: `test-${bsId}`, bluesalesInfo: { create: { bsOrderId: bsId } },
    } });
    states.set(bsId, 0);
    return prisma.orderStatusChange.create({ data: {
      orderId: order.id, toStatusId: status, toStatusName: `Status ${status}`,
      nextAttemptAt: new Date(Date.now() - 20_000), ...extra,
    } });
  };
  const rows = () => prisma.orderStatusChange.findMany({ orderBy: { id: 'asc' } });
  const requests = () => calls.filter((c) => c[0] !== 'label');
  const readyRetries = () => prisma.orderStatusChange.updateMany({
    where: { state: 'RETRY' }, data: { nextAttemptAt: new Date(Date.now() - 20_000) },
  });
  const flush = async () => service.deliverBatch(await service.claimBatch());
  try {
    await t.test('waits 10 seconds from oldest task, includes later arrivals, and persists window across restart', async (t) => {
      await reset();
      const now = Date.now();
      t.mock.timers.enable({ apis: ['Date'], now });
      await make(1, 7, { nextAttemptAt: new Date(now) });
      assert.deepEqual(await service.claimBatch(), []);
      t.mock.timers.setTime(now + 9000);
      await make(2, 7, { nextAttemptAt: new Date() });
      service = new OrderStatusOutboxProcessor(prisma, api, config);
      service.logger = silent;
      assert.deepEqual(await service.claimBatch(), []);
      t.mock.timers.setTime(now + 10000);
      const batch = await service.claimBatch();
      assert.equal(batch.length, 2);
      await service.deliverBatch(batch);
      assert.deepEqual(requests(), [['write', [1, 2], 7], ['read', [1, 2]]]);
      assert.ok((await rows()).every((r) => r.state === 'SUCCEEDED'));
    });
    await t.test('groups different target statuses and verifies all groups in one request', async () => {
      await reset();
      await make(1); await make(2); await make(3, 8);
      await flush();
      assert.deepEqual(requests(), [['write', [1, 2], 7], ['write', [3], 8], ['read', [1, 2, 3]]]);
      assert.ok(calls.some((c) => c[1] === 'order-status-batch-write'));
      assert.ok(calls.some((c) => c[1] === 'order-status-batch-verify'));
    });
    await t.test('preserves order transitions and does not overwrite cache while a newer change is pending', async () => {
      await reset();
      const first = await make(1, 7); await make(1, 8); await make(2, 9);
      await flush();
      assert.deepEqual((await rows()).map((r) => r.state), ['SUCCEEDED', 'PENDING', 'SUCCEEDED']);
      assert.equal((await prisma.bluesalesOrderInfo.findUnique({ where: { orderId: first.orderId } })).orderStatusId, null);
      await flush();
      assert.equal(states.get(1), 8);
      assert.equal((await prisma.bluesalesOrderInfo.findUnique({ where: { orderId: first.orderId } })).orderStatusId, 8);
    });
    await t.test('failed verification retries GET only, including after processor restart', async () => {
      await reset(); await make(1); await make(2);
      onRead = () => { throw new Error('read timed out'); };
      await flush();
      assert.ok((await rows()).every((r) => r.state === 'RETRY'));
      await readyRetries();
      service = new OrderStatusOutboxProcessor(prisma, api, config); service.logger = silent;
      onRead = null;
      await flush();
      assert.deepEqual(requests(), [['write', [1, 2], 7], ['read', [1, 2]], ['read', [1, 2]]]);
      assert.ok((await rows()).every((r) => r.state === 'SUCCEEDED'));
    });
    await t.test('uncertain partial write checks all and rewrites only unmatched orders', async () => {
      await reset(); await make(1); await make(2);
      onWrite = (ids, status) => { states.set(ids[0], status); throw new Error('connection lost'); };
      await flush();
      await readyRetries(); onWrite = null;
      await flush();
      assert.deepEqual(requests(), [['write', [1, 2], 7], ['read', [1, 2]], ['write', [2], 7], ['read', [2]]]);
      assert.ok((await rows()).every((r) => r.state === 'SUCCEEDED'));
    });
    await t.test('unavailable retry verification does not blindly resend, while fresh orders proceed', async () => {
      await reset(); await make(1, 7, { state: 'RETRY', attempts: 1 }); await make(2, 8);
      onRead = (ids) => {
        if (ids.includes(1)) throw new Error('unavailable');
        return ids.map((id) => ({ id, orderStatus: { id: states.get(id) } }));
      };
      await flush();
      assert.deepEqual(requests(), [['read', [1]], ['write', [2], 8], ['read', [2]]]);
      assert.deepEqual((await rows()).map((r) => r.state), ['RETRY', 'SUCCEEDED']);
    });
    await t.test('recovers interrupted processing with zero attempts by verifying first', async () => {
      await reset(); await make(1, 7, { state: 'PROCESSING', lockedAt: new Date(), leaseToken: 'old' });
      states.set(1, 7);
      await service.recoverQueueOnStartup(); await readyRetries();
      await flush();
      assert.deepEqual(requests(), [['read', [1]]]);
      assert.equal((await rows())[0].state, 'SUCCEEDED');
    });
    await t.test('partial verification retries only mismatch; repeated missing order fails without another write', async () => {
      await reset(); await make(1); await make(2); await make(3);
      onWrite = () => { states.set(1, 7); states.delete(3); };
      await flush();
      assert.deepEqual((await rows()).map((r) => r.state), ['SUCCEEDED', 'RETRY', 'RETRY']);
      await readyRetries(); onWrite = null;
      await flush();
      assert.deepEqual(requests(), [
        ['write', [1, 2, 3], 7], ['read', [1, 2, 3]], ['read', [2, 3]], ['write', [2], 7], ['read', [2]],
      ]);
      assert.deepEqual((await rows()).map((r) => r.state), ['SUCCEEDED', 'SUCCEEDED', 'FAILED']);
    });
    await t.test('one failed status group does not block another group', async () => {
      await reset(); await make(1); await make(2, 8);
      onWrite = (ids, status) => {
        if (status === 7) throw new Error('failed write');
        ids.forEach((id) => states.set(id, status));
      };
      await flush();
      assert.deepEqual(requests(), [['write', [1], 7], ['write', [2], 8], ['read', [2]]]);
      assert.deepEqual((await rows()).map((r) => r.state), ['RETRY', 'SUCCEEDED']);
    });
    await t.test('lease loss during write prevents verification and completion by old owner', async () => {
      await reset(); await make(1);
      onWrite = async () => prisma.orderStatusChange.updateMany({ data: { leaseToken: 'new-owner' } });
      await flush();
      assert.deepEqual(requests(), [['write', [1], 7]]);
      assert.equal((await rows())[0].state, 'PROCESSING');
    });
    await t.test('concurrent claims never claim two pending transitions of the same order', async () => {
      await reset(); await make(1); await make(1, 8); await make(2);
      const other = new OrderStatusOutboxProcessor(prisma, api, config);
      const batches = await Promise.all([service.claimBatch(), other.claimBatch()]);
      const claimed = batches.flat();
      assert.equal(claimed.length, 2);
      assert.equal(new Set(claimed.map((c) => c.orderId)).size, 2);
    });
    await t.test('batch is capped at 500 and leaves overflow queued', async () => {
      await reset();
      await prisma.order.createMany({ data: Array.from({ length: 501 }, (_, i) => ({ orderNumber: `limit-${i}` })) });
      const orders = await prisma.order.findMany();
      await prisma.orderStatusChange.createMany({ data: orders.map((o) => ({
        orderId: o.id, toStatusId: 7, toStatusName: 'Status', nextAttemptAt: new Date(Date.now() - 20000),
      })) });
      assert.equal((await service.claimBatch()).length, 500);
      assert.equal(await prisma.orderStatusChange.count({ where: { state: 'PENDING' } }), 1);
    });
  } finally {
    await prisma.$disconnect();
  }
});
