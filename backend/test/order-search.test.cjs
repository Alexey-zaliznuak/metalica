// Run after npm run build: node --test test/order-search.test.cjs
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { OrdersService } = require('../dist/orders/orders.service');
const { OrdersController } = require('../dist/orders/orders.controller');

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

test('urgent tag filter applies before pagination and combines with other board filters', async () => {
  const { service, calls } = setup();
  let listWhere;
  let include;
  service.prisma.order.findMany = async (query) => { listWhere = query.where; include = query.include; return []; };
  await service.findAll({ onlyUrgent: true, orderStatusId: 3, withoutPinnedSketches: true, deliveryManagers: ['Менеджер'] });
  const predicate = { equals: 'Срочно', mode: 'insensitive' };
  assert.deepEqual(calls.where.AND, [
    { bluesalesInfo: { is: { orderStatusId: 3 } } },
    { deliveryManagerName: { in: ['Менеджер'] } },
    { pinnedSketches: { none: {} } },
    { lead: { is: { tags: { some: { name: predicate } } } } },
  ]);
  assert.deepEqual(listWhere, calls.where, 'list and count must filter the same orders');
  assert.deepEqual(include.lead.select.tags.where.name, predicate, 'filter must match the existing urgent badge');
});

test('disabled or missing urgent filter includes orders without the tag and without a lead', async () => {
  for (const onlyUrgent of [undefined, false]) {
    const { service, calls } = setup();
    await service.findAll({ onlyUrgent });
    assert.deepEqual(calls.where, {});
  }
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

test('size multiselect matches either SKU before pagination and combines with other filters', async () => {
  const { service, calls } = setup();
  let list;
  service.prisma.order.findMany = async (query) => { list = query; return []; };
  await service.findAll({ sizes: ['30x40', '60x80'], onlyUrgent: true, orderStatusId: 3, page: 2, limit: 1 });
  assert.deepEqual(calls.where.AND[2], { bluesalesInfo: { is: { OR: [
    { rawPayload: { path: ['goodsPositions'], array_contains: [{ goods: { marking: 'Картина на металле 30*40см' } }] } },
    { rawPayload: { path: ['goodsPositions'], array_contains: [{ goods: { marking: 'Картина на металле 60*80см' } }] } },
  ] } } });
  assert.deepEqual(list.where, calls.where);
  assert.equal(list.skip, 1);
  assert.equal(list.take, 1);
});

test('empty size selection leaves all orders available, duplicates do not repeat a SKU', async () => {
  for (const sizes of [undefined, []]) {
    const { service, calls } = setup();
    await service.findAll({ sizes });
    assert.deepEqual(calls.where, {});
  }
  const { service, calls } = setup();
  await service.findAll({ sizes: ['40x60', '40x60'] });
  assert.equal(calls.where.AND[0].bluesalesInfo.is.OR.length, 1);
  assert.equal(calls.where.AND[0].bluesalesInfo.is.OR[0].rawPayload.array_contains[0].goods.marking, 'Картина на металле 40*60см');
});

test('unsupported sizes fail before querying instead of silently removing the filter', async () => {
  for (const size of ['50x70', 'constructor', 'toString', '__proto__']) {
    const { service, calls } = setup();
    await assert.rejects(service.findAll({ sizes: ['30x40', size] }), (error) => error.getStatus() === 400);
    assert.equal(calls.where, null);
    assert.equal(calls.raw, 0);
  }
});

test('size query accepts one or several selections and trims empty values', async () => {
  for (const [input, expected] of [['30x40', ['30x40']], [[' 40x60 ', '', '60x80'], ['40x60', '60x80']], ['', undefined]]) {
    let params;
    const controller = new OrdersController({ findAll: (value) => { params = value; } });
    const args = Array(16).fill(undefined);
    args[13] = input;
    controller.findAll(...args);
    assert.deepEqual(params.sizes, expected);
  }
});
