const { test } = require('node:test');
const assert = require('node:assert/strict');
const { order, config } = require('./metavista.fixture.cjs');
const { MetavistaService } = require('../dist/metavista/metavista.service');
const { MetavistaBsService } = require('../dist/metavista/metavista-bs.service');
const { BluesalesDiagController } = require('../dist/bluesales/bluesales-diag.controller');
const { OrderEventsService } = require('../dist/orders/order-events.service');
const { BluesalesInvalidResponseError } = require('../dist/bluesales/bluesales-api.service');

// In-memory persistence and BS transport; run the real queue/export/linking code.
function harness(count = 1, options = {}) {
  const rows = Array.from({ length: count }, (_, i) => {
    const snapshot = order({ id: `MV-${String(900000 + i).padStart(6, '0')}` });
    snapshot.customer.email = `customer-${i % 7}@example.invalid`;
    return { externalId: snapshot.id, orderId: i + 1, snapshot, deletedAt: null,
      exportState: i < 7 ? 'REVIEW' : 'RETRY', bsCustomerId: null, bsOrderId: null,
      customerAttemptAt: i < 7 ? new Date(0) : null, orderAttemptAt: null,
      nextAttemptAt: new Date(i < 7 ? Date.now() + 3600_000 : 0), exchangeRate: null };
  });
  const leads = [], infos = [], events = [], logs = [], calls = [], customers = [], orders = [];
  const state = { lastPollAt: new Date(), lockToken: null, lockedUntil: null };
  const match = (row, where) => Object.entries(where).every(([key, value]) => {
    if (value && typeof value === 'object') {
      if ('in' in value) return value.in.includes(row[key]);
      if ('lte' in value) return row[key] <= value.lte;
    }
    return row[key] === value;
  });
  const db = {
    $transaction: work => work(db),
    $queryRaw: async (_, email) => rows.filter(r => r.snapshot.customer.email === email && r.bsCustomerId != null)
      .map(r => ({ bsCustomerId: r.bsCustomerId })),
    metavistaSyncState: {
      upsert: async () => state,
      findUniqueOrThrow: async () => state,
      updateMany: async ({ data }) => { Object.assign(state, data); return { count: 1 }; },
    },
    metavistaOrder: {
      findUniqueOrThrow: async ({ where }) => structuredClone(rows.find(r => r.externalId === where.externalId)),
      findMany: async ({ where, take }) => rows.filter(r => match(r, where))
        .sort((a, b) => a.nextAttemptAt - b.nextAttemptAt).slice(0, take).map(r => structuredClone(r)),
      updateMany: async ({ where, data }) => {
        const found = rows.filter(r => match(r, where));
        found.forEach(r => Object.assign(r, data));
        return { count: found.length };
      },
      update: async ({ where, data }) => {
        const row = rows.find(r => r.externalId === where.externalId);
        Object.assign(row, data); return structuredClone(row);
      },
    },
    lead: {
      findMany: async ({ where }) => leads.filter(l => l.email === where.email)
        .sort((a, b) => a.bsCustomerId - b.bsCustomerId).slice(0, 1),
      upsert: async ({ where, create, update }) => {
        let lead = leads.find(l => l.bsCustomerId === where.bsCustomerId);
        if (lead) Object.assign(lead, update);
        else { lead = { id: leads.length + 1, ...create }; leads.push(lead); }
        return lead;
      },
    },
    bluesalesTag: { upsert: async () => {} },
    bluesalesOrderStatus: { findFirst: async () => ({ bsOrderStatusId: 999 }) },
    bluesalesOrderInfo: {
      findUnique: async ({ where }) => infos.find(i => i.bsOrderId === where.bsOrderId) ?? null,
      upsert: async ({ where, create, update }) => {
        const info = infos.find(i => i.orderId === where.orderId);
        if (info) Object.assign(info, update); else infos.push(create);
      },
    },
    order: { update: async () => {} },
    orderEvent: { create: async ({ data }) => {
      if (options.auditFailure) throw new Error('audit storage unavailable');
      events.push({ id: events.length + 1, ...structuredClone(data) });
    } },
  };
  let customerFailures = options.customerFailures ?? 0, orderFailures = options.orderFailures ?? 0;
  const api = {
    isConfigured: true,
    getOrdersByIds: async () => [],
    send: async (method, data) => {
      calls.push({ method, data });
      if (method === 'customers.add') {
        assert.equal(data.firstContactDate, '2026-10-29');
        assert.deepEqual(data.crmStatus, { name: 'Обратился' });
        const customer = { ...data, id: 100 + customers.length };
        customers.push(customer);
        if (options.customerError) throw options.customerError;
        if (customerFailures-- > 0) throw new Error('timeout secret-test');
        if (options.missingCustomerId) return { errorDetail: 'private customer data' };
        return customer;
      }
      if (method === 'customers.get') return { customers: customers.filter(c => data.ids.includes(c.id)) };
      if (method === 'orders.get') return { orders: options.hideOrders ? [] : orders.filter(o => o.customer.id === data.customerId), notReturnedCount: 0 };
      assert.equal(method, 'orders.add');
      const added = { ...data, id: 200 + orders.length };
      orders.push(added);
      if (orderFailures-- > 0) throw new Error('order timeout');
      return added;
    },
  };
  const settings = config({ METAVISTA_ENABLED: 'true', METAVISTA_API_KEY: 'secret-test' });
  const service = new MetavistaService(db, settings, {}, new MetavistaBsService(api, db, settings),
    { current: async () => ({ rate: 90, source: 'test' }) }, { upsertOrder: async () => {} });
  service.logger = Object.fromEntries(['log', 'warn', 'error'].map(level => [level, message => logs.push({ level, message })]));
  return { service, rows, infos, events, logs, calls, customers, orders, db };
}

test('the seven REVIEW and nine dependent RETRY orders resume and export in bounded batches', async () => {
  const h = harness(16);
  // Deleted records and orders already linked to BS must not be reset.
  h.rows.push({ ...h.rows[0], externalId: 'MV-999990', deletedAt: new Date() });
  h.rows.push({ ...h.rows[0], externalId: 'MV-999991', bsOrderId: 777 });
  await h.service.tick();
  assert.equal(h.rows.filter(r => r.exportState === 'EXPORTED').length, 5);
  for (let i = 0; i < 3; i++) await h.service.tick();
  assert.ok(h.rows.slice(0, 16).every(r => r.exportState === 'EXPORTED' && r.bsCustomerId && r.bsOrderId));
  assert.equal(h.customers.length, 7);
  assert.equal(h.orders.length, 16);
  assert.ok(h.orders.every(o => o.orderStatus.name === 'Заявка с сайта'));
  assert.ok(h.infos.every(i => i.orderStatus === 'Заявка с сайта' && i.orderStatusId === 999));
  assert.ok(h.rows.slice(16).every(r => r.exportState === 'REVIEW'));
  assert.equal(h.events.filter(e => e.meta.outcome === 'success').length, 16);
});

test('lost customer response is retried after one minute and the error history survives success', async () => {
  const h = harness(1, { customerFailures: 2 });
  const started = Date.now();
  await h.service.tick();
  const row = h.rows[0];
  assert.equal(row.exportState, 'RETRY');
  assert.equal(row.bsCustomerId, null);
  assert.ok(row.nextAttemptAt >= started + 60_000 && row.nextAttemptAt <= Date.now() + 60_000);
  const failure = h.events.find(e => e.meta.outcome === 'error');
  assert.equal(failure.meta.stage, 'customers.add');
  assert.equal(failure.meta.error, 'timeout [redacted]');
  assert.equal(failure.meta.nextAttemptAt, row.nextAttemptAt.toISOString());
  await h.service.tick();
  assert.equal(h.customers.length, 1, 'do not retry before the scheduled time');
  row.nextAttemptAt = new Date(0);
  await h.service.tick();
  assert.equal(row.exportState, 'RETRY');
  assert.equal(h.events.filter(e => e.meta.outcome === 'error').length, 2);
  assert.notEqual(h.events.at(-1).meta.attemptId, failure.meta.attemptId);
  row.nextAttemptAt = new Date(0);
  await h.service.tick();
  assert.equal(row.exportState, 'EXPORTED');
  assert.equal(h.customers.length, 3, 'an uncertain creation no longer blocks delivery');
  assert.equal(h.orders.length, 1);
  assert.equal(row.lastError, null);
  assert.equal(h.events.filter(e => e.meta.outcome === 'error').length, 2);
  assert.notEqual(h.events.at(-1).meta.attemptId, failure.meta.attemptId);
  assert.equal(h.events.at(-1).meta.bsOrderId, row.bsOrderId);
  assert.ok(h.logs.some(l => l.message.includes('повтор=')));
  assert.ok(!JSON.stringify(h.events).includes('secret-test'));
});

for (const hideOrders of [false, true]) test(`lost order response recovers with marker visible=${!hideOrders}`, async () => {
  const h = harness(1, { orderFailures: 1, hideOrders });
  await h.service.tick();
  assert.equal(h.rows[0].exportState, 'RETRY');
  assert.equal(h.events.at(-1).meta.stage, 'orders.add');
  h.rows[0].nextAttemptAt = new Date(0);
  await h.service.tick();
  assert.equal(h.rows[0].exportState, 'EXPORTED');
  assert.equal(h.customers.length, 1, 'reuse the saved customer ID');
  assert.equal(h.orders.length, hideOrders ? 2 : 1);
  await h.service.exportOrder(h.rows[0].externalId);
  assert.equal(h.orders.length, hideOrders ? 2 : 1, 'already linked orders are not recreated');
});

test('logging failures do not retry successful external writes', async () => {
  const h = harness(1, { auditFailure: true });
  await h.service.tick();
  await h.service.tick();
  assert.equal(h.rows[0].exportState, 'EXPORTED');
  assert.equal(h.customers.length, 1); assert.equal(h.orders.length, 1);
  assert.ok(h.logs.some(l => l.message.includes('не сохранена')));
});

test('missing IDs retain useful stage and response field names without response values', async () => {
  const h = harness(1, { missingCustomerId: true });
  await h.service.tick();
  assert.equal(h.rows[0].exportState, 'RETRY');
  assert.match(h.events.at(-1).meta.error, /errorDetail/);
  assert.ok(!JSON.stringify(h.events).includes('private customer data'));
  assert.equal(h.orders.length, 0);
});

test('HTML failure details survive in persistent history and retry logs stay on one line', async () => {
  const body = 'page text '.repeat(200) + 'actual error secret-test';
  const h = harness(1, { customerError: new BluesalesInvalidResponseError({
    method: 'customers.add', status: 200, contentType: 'text/html', redirected: true,
    path: '/app/Error.aspx', bodyChars: 9000, body,
  }) });
  await h.service.tick();
  assert.equal(h.rows[0].exportState, 'RETRY');
  const event = h.events.at(-1).meta;
  assert.equal(event.stage, 'customers.add');
  assert.ok(event.response.body.endsWith('actual error [redacted]'));
  assert.ok(event.response.body.length > 1000);
  assert.equal(event.response.status, 200);
  assert.ok(!JSON.stringify(h.events).includes('secret-test'));
  assert.ok(h.logs.some(l => l.message.includes('повтор=') && l.message.includes('HTTP=200')));
  assert.ok(h.logs.every(l => !/[\r\n]/.test(l.message)));
  assert.equal(h.orders.length, 0);
});

test('multiline transport errors keep the reason and retry time visible to grep', async () => {
  const h = harness(1, { customerError: new Error('Network error:\r\nsecond line secret-test') });
  await h.service.tick();
  assert.equal(h.events.at(-1).meta.error, 'Network error: second line [redacted]');
  assert.ok(h.logs.some(l => /Network error: second line \[redacted\]; повтор=/.test(l.message)));
});

test('diagnostics paginate persistent history and the regular timeline excludes technical events', async () => {
  let eventsQuery;
  const db = {
    metavistaOrder: { findUnique: async () => ({ externalId: 'MV-900000', orderId: 1 }) },
    orderEvent: { findMany: async query => {
      eventsQuery = query;
      return Array.from({ length: 51 }, (_, i) => ({ id: 100 - i }));
    } },
  };
  const controller = new BluesalesDiagController(db, {});
  const result = await controller.metavista('MV-900000', '101');
  assert.equal(result.events.length, 50); assert.equal(result.nextBeforeId, 51);
  assert.deepEqual(eventsQuery.where, { orderId: 1, field: 'metavistaExport', id: { lt: 101 } });
  await assert.rejects(controller.metavista('wrong'), /Неверный номер/);
  await assert.rejects(controller.metavista('MV-900000', '-1'), /Неверный beforeId/);
  db.orderEvent.findMany = async query => { eventsQuery = query; return []; };
  assert.equal((await controller.metavista('MV-900000', '51')).nextBeforeId, null);
  await new OrderEventsService(db).list(1);
  assert.deepEqual(eventsQuery.where, { orderId: 1, field: { not: 'metavistaExport' } });
});
