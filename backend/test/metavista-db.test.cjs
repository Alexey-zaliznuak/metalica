// Local development DB only. Each test rolls back all writes, including fixtures.
require('dotenv').config({ quiet: true });
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { PrismaClient } = require('@prisma/client');
const { order, config } = require('./metavista.fixture.cjs');
const { MetavistaService } = require('../dist/metavista/metavista.service');
if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(process.env.DATABASE_URL).hostname)) {
  throw new Error('Metavista DB tests require a local database');
}
const prisma = new PrismaClient();
after(() => prisma.$disconnect());
const rollback = Symbol('rollback');
async function isolated(fn) {
  try {
    await prisma.$transaction(async tx => {
      assert.equal(await tx.metavistaOrder.count({ where: { externalId: 'MV-999981' } }), 0, 'fixture ID must be unused');
      const db = new Proxy(tx, { get(target, key) { return key === '$transaction' ? async work => work(db) : target[key]; } });
      const service = new MetavistaService(db, config(), {}, {}, {}, { upsertOrder: async () => {} });
      service.assertLock = async () => {};
      await fn(service, db);
      throw rollback;
    }, { timeout: 30_000 });
  } catch (error) { if (error !== rollback) throw error; }
}
test('replaying an order and older revision never creates a second CRM card', () => isolated(async (service, db) => {
  await service.importOrder(order());
  await service.importOrder(order());
  await service.importOrder(order({ revision: 0 }));
  assert.equal(await db.order.count({ where: { orderNumber: order().id } }), 1);
  assert.equal((await db.metavistaOrder.findUnique({ where: { externalId: order().id } })).revision, 1);
}));
test('failed file download does not advance cursor; replay resumes, deletion is durable, restore requires newer revision', () => isolated(async (service, db) => {
  await db.metavistaSyncState.upsert({ where: { id: 1 }, create: { id: 1, initialized: true }, update: { cursor: 0, initialized: true } });
  const source = order();
  source.items[0].files = [{ id: 'a'.repeat(32), slot: 'final', mime: 'image/jpeg', bytes: 3, downloadUrl: 'https://untrusted.invalid/leak' }];
  let fail = true, uploads = 0;
  const page = { schemaVersion: 1, orders: [source], deletedOrders: [], nextCursor: 1, hasMore: false };
  service.request = async path => {
    if (path.startsWith('/orders?')) return { json: async () => page };
    assert.equal(path, `/orders/${source.id}/files/${'a'.repeat(32)}`);
    if (fail) throw new Error('download failed');
    return new Response(Buffer.from([1, 2, 3]), { headers: { 'Content-Type': 'image/jpeg' } });
  };
  service.storage = { upload: async () => { uploads++; return { key: 'metavista-test.jpg' }; }, stat: async () => null };
  await assert.rejects(service.poll(), /download failed/);
  assert.equal((await db.metavistaSyncState.findUnique({ where: { id: 1 } })).cursor, 0);
  fail = false; await service.poll();
  assert.equal((await db.metavistaSyncState.findUnique({ where: { id: 1 } })).cursor, 1);
  await service.importOrder(source); assert.equal(uploads, 1);
  page.orders = []; page.deletedOrders = [{ id: source.id, revision: 2, deletedAt: new Date().toISOString() }]; page.nextCursor = 2;
  await service.poll();
  await service.importOrder(source);
  assert.equal((await db.metavistaOrder.findUnique({ where: { externalId: source.id } })).exportState, 'DELETED');
  await service.importOrder({ ...source, revision: 3 });
  const restored = await db.metavistaOrder.findUnique({ where: { externalId: source.id } });
  assert.equal(restored.deletedAt, null); assert.equal(restored.exportState, 'PENDING'); assert.equal(uploads, 1);
}));
test('unpaid orders export immediately once with stable FX and no invented payment', () => isolated(async (service, db) => {
  const unpaid = order({ payment: { status: 'unpaid', paidAmount: null, paidAt: null } });
  await service.importOrder(unpaid);
  assert.equal((await db.metavistaOrder.findUnique({ where: { externalId: unpaid.id } })).exportState, 'PENDING');
  let adds = 0, payload;
  service.bs = { tagId: async () => {
    await db.bluesalesTag.upsert({ where: { bsTagId: '1999999981' }, create: { bsTagId: '1999999981', name: 'Test Spain' }, update: {} });
    return 1999999981;
  }, findCustomer: async () => ({ id: 1999999981 }), customer: async () => ({ id: 1999999981, fullName: 'Test' }), ensureTag: async () => {},
    findOrder: async () => null, send: async (method, data) => { assert.equal(method, 'orders.add'); adds++; payload = data; return { id: 1999999981 }; },
    api: { getOrdersByIds: async () => [] } };
  service.rates = { current: async () => ({ rate: 90, source: 'fallback' }) };
  await service.exportOrder(unpaid.id); assert.equal(adds, 1); assert.equal(payload.prepay, 0);
  await service.importOrder(order({ revision: 2 }));
  await service.exportOrder(unpaid.id);
  await service.exportOrder(unpaid.id);
  assert.equal(adds, 1); assert.match(payload.internalComments, /^Metavista: MV-999981/);
  const row = await db.metavistaOrder.findUnique({ where: { externalId: unpaid.id } });
  assert.equal(row.exportState, 'EXPORTED'); assert.equal(Number(row.exchangeRate), 90);
  const info = await db.bluesalesOrderInfo.findUnique({ where: { orderId: row.orderId } });
  assert.equal(info.totalSum, 7371, 'CRM total must include the full 81.9 EUR including shipping');
  assert.equal(await db.order.count({ where: { id: row.orderId, source: 'BLUESALES' } }), 1);
}));
test('unknown create result is reconciled by marker and never blindly retried', () => isolated(async (service, db) => {
  await service.importOrder(order());
  await db.metavistaOrder.update({ where: { externalId: order().id }, data: { bsCustomerId: 1999999981, orderAttemptAt: new Date() } });
  await db.bluesalesTag.upsert({ where: { bsTagId: '1999999981' }, create: { bsTagId: '1999999981', name: 'Test Spain' }, update: {} });
  service.bs = { tagId: async () => 1999999981, customer: async () => ({ id: 1999999981 }), ensureTag: async () => {},
    findOrder: async () => null, send: async () => assert.fail('Must not create again'), api: { getOrdersByIds: async () => [] } };
  await assert.rejects(service.exportOrder(order().id), /Автоповтор запрещён/);
  service.bs.findOrder = async () => ({ id: 1999999981 });
  await service.exportOrder(order().id);
  assert.equal((await db.metavistaOrder.findUnique({ where: { externalId: order().id } })).bsOrderId, 1999999981);
}));

test('unmatched products and files are imported, and old skipped records are recovered without resetting the cursor', () => isolated(async (service, db) => {
  await db.metavistaSyncState.upsert({ where: { id: 1 }, create: { id: 1, initialized: true, cursor: 23 }, update: { cursor: 23, initialized: true } });
  const source = order({ status: 'refunded' });
  source.items[0].spec = 'L · 61 × 45,7 cm';
  source.items[0].files = [{ id: 'b'.repeat(32), slot: 'final', mime: 'image/jpeg', bytes: 3 }];
  await db.metavistaOrder.create({ data: { externalId: source.id, revision: source.revision, exportState: 'SKIPPED', snapshot: { ...source, items: [] } } });
  let uploads = 0;
  service.request = async path => path === `/orders/${source.id}` ? { json: async () => source }
    : new Response(Buffer.from([1, 2, 3]), { headers: { 'Content-Type': 'image/jpeg' } });
  service.storage = { upload: async () => { uploads++; return { key: 'metavista-test.jpg' }; }, stat: async () => null };
  await service.requeuePreviouslyExcluded();
  const imported = await db.metavistaOrder.findUnique({ where: { externalId: source.id } });
  assert.equal(imported.exportState, 'PENDING'); assert.ok(imported.orderId);
  assert.equal(imported.snapshot.items.length, 1); assert.equal(uploads, 1);
  assert.equal((await db.metavistaSyncState.findUnique({ where: { id: 1 } })).cursor, 23);
  await service.requeuePreviouslyExcluded(); assert.equal(uploads, 1);
  assert.equal(await db.order.count({ where: { orderNumber: source.id } }), 1);
}));

test('old waiting orders recover at the same revision, while file failures remain excluded from export until retry succeeds', () => isolated(async (service, db) => {
  const source = order({ status: 'cancelled', payment: { status: 'unpaid', paidAmount: null, paidAt: null } });
  await service.importOrder(source);
  await db.metavistaOrder.update({ where: { externalId: source.id }, data: { exportState: 'WAITING_PAYMENT' } });
  service.request = async () => { throw new Error('Metavista unavailable'); };
  await service.requeuePreviouslyExcluded();
  let row = await db.metavistaOrder.findUnique({ where: { externalId: source.id } });
  assert.equal(row.exportState, 'WAITING_PAYMENT'); assert.match(row.lastError, /unavailable/);
  await db.metavistaOrder.update({ where: { externalId: source.id }, data: { nextAttemptAt: new Date(0) } });
  service.request = async () => ({ json: async () => source });
  await service.requeuePreviouslyExcluded();
  row = await db.metavistaOrder.findUnique({ where: { externalId: source.id } });
  assert.equal(row.exportState, 'PENDING'); assert.equal(row.lastError, null);
}));
