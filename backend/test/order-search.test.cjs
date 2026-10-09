// Run after npm run build: node --test test/order-search.test.cjs
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { OrdersService } = require('../dist/orders/orders.service');

function setup({ exact = null, matches = [], orders = [] } = {}) {
  const calls = { raw: 0, where: null };
  const service = Object.create(OrdersService.prototype);
  service.textSearchCache = new Map();
  service.prisma = {
    order: {
      findUnique: async () => exact,
      count: async ({ where }) => { calls.where = where; return orders.length; },
      findMany: async () => orders,
    },
    $queryRaw: async () => { calls.raw++; return matches; },
  };
  service.computeStatsBatch = async () => new Map();
  service.lastMessagesBatch = async () => new Map();
  service.buildOrderView = (order) => ({ id: order.id, orderNumber: order.orderNumber });
  return { service, calls };
}

test('exact order number takes priority and skips the text scan', async () => {
  const { service, calls } = setup({
    exact: { id: 7 },
    orders: [{ id: 7, orderNumber: '123456' }],
  });
  const result = await service.findAll({ q: '123456', orderStatusId: 3 });
  assert.deepEqual(calls.where.AND, [
    { bluesalesInfo: { is: { orderStatusId: 3 } } },
    { id: 7 },
  ]);
  assert.equal(calls.raw, 0);
  assert.equal(result.items[0].searchMatch, null);
});

test('text matches include message count and comment flag and share one scan', async () => {
  const { service, calls } = setup({
    matches: [{ orderId: 9, messageCount: 2, comment: true }],
    orders: [{ id: 9, orderNumber: '789' }],
  });
  const [first, second] = await Promise.all([
    service.findAll({ q: 'эскиз готов', orderStatusId: 3 }),
    service.findAll({ q: 'эскиз готов', orderStatusId: 4 }),
  ]);
  assert.equal(calls.raw, 1);
  assert.deepEqual(first.items[0].searchMatch, { messageCount: 2, comment: true });
  assert.deepEqual(second.items[0].searchMatch, { messageCount: 2, comment: true });
  assert.deepEqual(calls.where.AND[1].OR[2], { id: { in: [9] } });
});

test('short number query keeps the light search only', async () => {
  const { service, calls } = setup();
  await service.findAll({ q: '1234' });
  assert.equal(calls.raw, 0);
  assert.deepEqual(calls.where.AND[0].OR[0], {
    orderNumber: { contains: '1234', mode: 'insensitive' },
  });
});

test('text shorter than six characters does not activate search', async () => {
  const { service, calls } = setup();
  await service.findAll({ q: 'эскиз' });
  assert.equal(calls.raw, 0);
  assert.deepEqual(calls.where, {});
});

test('orders without pinned sketches use the same relation filter for count and pagination', async () => {
  const { service, calls } = setup();
  let listWhere;
  service.prisma.order.findMany = async ({ where }) => { listWhere = where; return []; };
  await service.findAll({ withoutPinnedSketches: true, orderStatusId: 3, ignoreDesigners: true });
  assert.deepEqual(calls.where.AND, [
    { bluesalesInfo: { is: { orderStatusId: 3 } } },
    { pinnedSketches: { none: {} } },
  ]);
  assert.deepEqual(listWhere, calls.where);
});

test('disabled pinned sketch filter leaves all orders available', async () => {
  const { service, calls } = setup();
  await service.findAll({ withoutPinnedSketches: false });
  assert.deepEqual(calls.where, {});
});

test('shipping deadline range filters count and paginated items together', async () => {
  const { service, calls } = setup({ matches: [{ orderId: 7 }, { orderId: 9 }] });
  let listWhere;
  let sql;
  let values;
  service.prisma.order.findMany = async ({ where }) => { listWhere = where; return []; };
  service.prisma.$queryRaw = async (strings, ...params) => {
    sql = strings.join('?');
    values = params;
    return [{ orderId: 7 }, { orderId: 9 }];
  };
  await service.findAll({ shippingDeadlineFrom: '2026-10-01', shippingDeadlineTo: '2026-10-03', withoutPinnedSketches: true });
  assert.deepEqual(calls.where.AND, [
    { pinnedSketches: { none: {} } },
    { id: { in: [7, 9] } },
  ]);
  assert.deepEqual(listWhere, calls.where);
  assert.deepEqual(values, ['2026-10-01', '2026-10-01', '2026-10-03', '2026-10-03']);
  assert.match(sql, /parsed.deadline >=/);
  assert.match(sql, /parsed.deadline <=/);
});

test('shipping deadline accepts either boundary and returns no orders for no matches', async () => {
  for (const params of [
    { shippingDeadlineFrom: '2026-10-01' },
    { shippingDeadlineTo: '2026-10-03' },
    { shippingDeadlineFrom: '2026-10-03', shippingDeadlineTo: '2026-10-03' },
  ]) {
    const { service, calls } = setup();
    await service.findAll(params);
    assert.deepEqual(calls.where, { AND: [{ id: { in: [] } }] });
    assert.equal(calls.raw, 1);
  }
});

test('shipping deadline rejects invalid dates and reversed ranges before querying', async () => {
  for (const params of [
    { shippingDeadlineFrom: '03.10.2026' },
    { shippingDeadlineTo: '2026-02-30' },
    { shippingDeadlineFrom: '2026-10-04', shippingDeadlineTo: '2026-10-03' },
  ]) {
    const { service, calls } = setup();
    await assert.rejects(service.findAll(params), (error) => error.getStatus() === 400);
    assert.equal(calls.raw, 0);
    assert.equal(calls.where, null);
  }
});

test('delivery type filter intersects other filters before pagination', async () => {
  const { service, calls } = setup();
  let listWhere;
  let query;
  service.prisma.order.findMany = async ({ where }) => { listWhere = where; return []; };
  service.prisma.$queryRaw = async (sql) => { query = sql; return [{ orderId: 8 }]; };
  await service.findAll({ deliveryTypes: ['СДЭК / Самовывоз', 'Почта'], withoutPinnedSketches: true });
  assert.deepEqual(calls.where.AND, [
    { pinnedSketches: { none: {} } },
    { id: { in: [8] } },
  ]);
  assert.deepEqual(listWhere, calls.where);
  assert.deepEqual(query.values, ['СДЭК / Самовывоз', 'Почта']);
});

test('delivery types with no matching orders return an empty selection', async () => {
  const { service, calls } = setup();
  await service.findAll({ deliveryTypes: ['Неизвестный тип'] });
  assert.deepEqual(calls.where, { AND: [{ id: { in: [] } }] });
});

test('delivery type options come from the same expression as filtering', async () => {
  const { service } = setup();
  service.prisma.order.findMany = async () => [];
  service.prisma.$queryRaw = async () => [{ deliveryType: 'Курьер' }, { deliveryType: 'СДЭК / Самовывоз' }];
  const options = await service.getManagerOptions();
  assert.deepEqual(options.deliveryTypes, ['Курьер', 'СДЭК / Самовывоз']);
});
