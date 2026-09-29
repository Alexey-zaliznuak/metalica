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
