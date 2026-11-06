// npm run build; REVISION_TEST_DATABASE_URL=<local URL> node --test test/revision-status.test.cjs
// All fixtures and changes are rolled back. No BlueSales requests are sent.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { PrismaClient } = require('@prisma/client');
const { trackRevisionStatusTransition, reconcileActiveRevisions } = require('../dist/orders/revision-status.service');
const { OrdersService } = require('../dist/orders/orders.service');
const { BluesalesSyncService } = require('../dist/bluesales/bluesales-sync.service');
const { OrderStatusOutboxProcessor } = require('../dist/orders/order-status-outbox.processor');

const START = 174704, READY = 179920, OTHER = 145342;
const silent = { log() {}, warn() {}, error() {}, debug() {} };
test('revision tracking through application services without SQL triggers',
  { skip: !process.env.REVISION_TEST_DATABASE_URL }, async (t) => {
  const url = new URL(process.env.REVISION_TEST_DATABASE_URL);
  assert.ok(['localhost', '127.0.0.1'].includes(url.hostname), 'Only local test databases are allowed');
  const db = new PrismaClient({ datasources: { db: { url: url.toString() } } });
  try {
    assert.deepEqual(await db.$queryRaw`SELECT tgname FROM pg_trigger
      WHERE tgrelid = '"BluesalesOrderInfo"'::regclass AND NOT tgisinternal`, []);
    const before = [await db.revision.count(), await db.revisionClosure.count()];
    const rollback = new Error('rollback test fixtures');
    await assert.rejects(db.$transaction(async (tx) => {
      const prisma = new Proxy(tx, { get: (target, key) =>
        key === '$transaction' ? (task) => task(tx) : target[key] });
      const suffix = randomUUID();
      const artist = await tx.user.create({ data: {
        username: `revision-test-${suffix}`, name: 'Revision test', passwordHash: 'unused', role: 'REVISION_DESIGNER',
      } });
      for (const [id, name] of [[START, 'Правки у художника'], [READY, 'Правка готова'], [OTHER, 'Доставлен']]) {
        await tx.bluesalesOrderStatus.upsert({ where: { bsOrderStatusId: id },
          create: { bsOrderStatusId: id, name }, update: {} });
      }
      let bsId = -1000000;
      const make = (status = OTHER, assigned = true) => tx.order.create({ data: {
        orderNumber: `revision-test-${suffix}-${--bsId}`, source: 'BLUESALES',
        revisionDesignerId: assigned ? artist.id : null,
        bluesalesInfo: { create: { bsOrderId: bsId, orderStatusId: status } },
      }, include: { bluesalesInfo: true } });
      const revisions = (orderId) => tx.revision.findMany({ where: { orderId }, orderBy: { id: 'asc' }, include: { closure: true } });
      const transition = async (orderId, status, time = new Date()) => {
        await tx.$queryRaw`SELECT "orderId" FROM "BluesalesOrderInfo" WHERE "orderId" = ${orderId} FOR UPDATE`;
        const old = await tx.bluesalesOrderInfo.findUniqueOrThrow({ where: { orderId } });
        await tx.bluesalesOrderInfo.update({ where: { orderId }, data: { orderStatusId: status } });
        await trackRevisionStatusTransition(tx, orderId, old.orderStatusId, status, time);
      };
      const orders = Object.assign(Object.create(OrdersService.prototype), {
        prisma, logger: silent, orderEvents: { buildCreateManyData: () => [] },
        notifications: { notifyOrderStatus: async () => {} }, assignment: { maybeAssign: async () => {} },
        findOne: async (id) => tx.order.findUnique({ where: { id } }),
      });
      const sync = Object.assign(Object.create(BluesalesSyncService.prototype), {
        prisma, logger: silent, inboundSync: { enabled: true },
        isClosesSketchStatus: async () => false, resolveSketchTimestampUpdate: async () => ({}),
        resolveOrderNumber: (order) => order.number, tryAutoAssign: async () => {},
        syncOrderArtistToBluesales: async () => {}, notifications: { notifyOrderStatus: async () => {} },
      });
      const importStatus = (order, status, time) => sync.upsertOrder({
        id: order.bluesalesInfo.bsOrderId, number: order.orderNumber,
        orderStatus: { id: status, name: `Status ${status}` },
      }, null, { orderId: order.id }, time);

      await t.test('manual changes open, close and reopen cycles; repeated status does not duplicate', async () => {
        const order = await make();
        await orders.updateOrderStatus(order.id, START);
        const opened = (await revisions(order.id))[0];
        assert.ok(opened);
        await orders.updateOrderStatus(order.id, START);
        assert.deepEqual(await revisions(order.id), [opened]);
        await orders.updateOrderStatus(order.id, READY);
        const closed = (await revisions(order.id))[0];
        assert.equal(closed.closure.closedById, artist.id);
        assert.deepEqual(closed.closure.openedAt, opened.openedAt);
        assert.ok(closed.closure.closedAt >= opened.openedAt);
        await orders.updateOrderStatus(order.id, READY);
        assert.deepEqual(await revisions(order.id), [closed]);
        await orders.updateOrderStatus(order.id, START);
        assert.equal((await revisions(order.id)).length, 2);
      });

      await t.test('legacy active requests keep IDs, dates and message links; ready closes all', async () => {
        const order = await make();
        const oldDate = new Date('2026-10-01T10:00:00Z');
        for (let i = 0; i < 2; i++) {
          const message = await tx.message.create({ data: { orderId: order.id, authorId: artist.id, body: 'Legacy request' } });
          await tx.revision.create({ data: { orderId: order.id, messageId: message.id, openedAt: oldDate, createdAt: oldDate } });
        }
        const legacy = await revisions(order.id);
        await transition(order.id, START);
        await transition(order.id, OTHER);
        await transition(order.id, START);
        assert.deepEqual(await revisions(order.id), legacy);
        await transition(order.id, READY);
        const closed = await revisions(order.id);
        closed.forEach((row, i) => {
          assert.deepEqual({ ...row, closure: null }, legacy[i]);
          assert.equal(row.closure.closedById, artist.id);
          assert.deepEqual(row.closure.openedAt, oldDate);
        });
      });

      await t.test('ready without an artist is tracked; unrelated statuses and ready without requests are no-ops', async () => {
        const order = await make(OTHER, false);
        await transition(order.id, READY);
        assert.equal((await revisions(order.id)).length, 0);
        const openedAt = new Date('2026-11-06T15:00:00Z');
        await transition(order.id, START, openedAt);
        await transition(order.id, OTHER);
        assert.equal((await revisions(order.id))[0].closure, null);
        await transition(order.id, READY, new Date(openedAt.getTime() - 1000));
        const closure = (await revisions(order.id))[0].closure;
        assert.equal(closure.closedById, null);
        assert.deepEqual(closure.closedAt, openedAt);
      });

      await t.test('BlueSales import uses observation time and ignores stale or pending updates', async () => {
        const order = await make();
        const start = new Date('2026-11-06T10:00:00Z'), finish = new Date('2026-11-06T11:00:00Z');
        await importStatus(order, START, start);
        const opened = (await revisions(order.id))[0];
        assert.deepEqual(opened.openedAt, start);
        await importStatus(order, READY, new Date(start.getTime() - 1));
        assert.deepEqual(await revisions(order.id), [opened]);
        const pending = await tx.orderStatusChange.create({ data: { orderId: order.id, toStatusId: START, toStatusName: 'Start' } });
        await importStatus(order, READY, finish);
        assert.deepEqual(await revisions(order.id), [opened]);
        await tx.orderStatusChange.delete({ where: { id: pending.id } });
        await importStatus(order, READY, finish);
        assert.deepEqual((await revisions(order.id))[0].closure.closedAt, finish);
        await importStatus(order, READY, new Date(finish.getTime() + 1000));
        assert.equal((await revisions(order.id)).length, 1);
      });

      await t.test('initial import opens cycles for both new and previously unlinked orders', async () => {
        for (const existing of [false, true]) {
          const number = `revision-import-${suffix}-${existing}`;
          if (existing) await tx.order.create({ data: { orderNumber: number } });
          const observed = new Date('2026-11-06T12:00:00Z');
          await sync.upsertOrder({ id: --bsId, number, orderStatus: { id: START, name: 'Start' } }, null, null, observed);
          const order = await tx.order.findUniqueOrThrow({ where: { orderNumber: number } });
          const rows = await revisions(order.id);
          assert.equal(rows.length, 1);
          assert.deepEqual(rows[0].openedAt, observed);
        }
      });

      await t.test('outbox confirmations track transitions once and respect newer observations', async () => {
        const order = await make();
        const processor = new OrderStatusOutboxProcessor(prisma, {}, { get: () => undefined }, { enabled: true });
        processor.logger = silent;
        const deliver = async (status, observedAt) => {
          const change = await tx.orderStatusChange.create({ data: { orderId: order.id,
            toStatusId: status, toStatusName: 'Status', state: 'PROCESSING', leaseToken: 'fixture' } });
          await processor.completeChange(change, { id: order.bluesalesInfo.bsOrderId,
            orderStatus: { id: status, name: 'Status' } }, observedAt);
        };
        await deliver(START, new Date('2026-11-06T10:00:00Z'));
        const opened = (await revisions(order.id))[0];
        assert.ok(opened);
        await deliver(START, new Date('2026-11-06T10:01:00Z'));
        await deliver(READY, new Date('2026-11-06T09:00:00Z'));
        assert.deepEqual(await revisions(order.id), [opened]);
        await deliver(READY, new Date('2026-11-06T11:00:00Z'));
        assert.equal((await revisions(order.id))[0].closure.closedById, artist.id);
      });

      await t.test('startup recovery is batched, idempotent and preserves active requests', async () => {
        const ids = [];
        const entered = new Date('2026-10-31T10:00:00Z');
        for (let i = 0; i < 101; i++) {
          const order = await make(START);
          ids.push(order.id);
          await tx.bluesalesOrderInfo.update({ where: { orderId: order.id }, data: { orderStatusEnteredAt: entered } });
        }
        const recovery = new Proxy(prisma, { get: (target, key) => key === 'bluesalesOrderInfo'
          ? { findMany: (args) => {
            assert.equal(args.take, 100);
            return tx.bluesalesOrderInfo.findMany({ ...args, where: { AND: [args.where, { orderId: { in: ids } }] } });
          } } : target[key] });
        await reconcileActiveRevisions(recovery);
        const first = await tx.revision.findMany({ where: { orderId: { in: ids } }, orderBy: { id: 'asc' } });
        assert.equal(first.length, 101);
        first.forEach((row) => assert.deepEqual(row.openedAt, entered));
        await reconcileActiveRevisions(recovery);
        assert.deepEqual(await tx.revision.findMany({ where: { orderId: { in: ids } }, orderBy: { id: 'asc' } }), first);
      });
      throw rollback;
    }, { timeout: 60000 }), (error) => error === rollback);
    assert.deepEqual([await db.revision.count(), await db.revisionClosure.count()], before,
      'All status/revision changes roll back together');
  } finally { await db.$disconnect(); }
});
