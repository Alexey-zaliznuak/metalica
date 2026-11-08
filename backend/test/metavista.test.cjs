const { test } = require('node:test');
const assert = require('node:assert/strict');
const { order, config } = require('./metavista.fixture.cjs');
const { validatePage, markerId } = require('../dist/metavista/metavista.types');
const { buildBsOrder } = require('../dist/metavista/metavista-payload');
const { matchingGoodsId, selectMappedOrder } = require('../dist/metavista/metavista-catalog');
const { metavistaConfig } = require('../dist/metavista/metavista.config');
const { EurRateService } = require('../dist/metavista/eur-rate.service');
const { MetavistaBsService } = require('../dist/metavista/metavista-bs.service');
const { MetavistaService } = require('../dist/metavista/metavista.service');

test('cursor accepts deletion-only pages and rejects out-of-page/stale revisions', () => {
  const page = { schemaVersion: 1, orders: [], deletedOrders: [{ id: 'MV-000001', revision: 2, deletedAt: '2026-11-08T00:00:00Z' }], nextCursor: 2, hasMore: false };
  validatePage(page, 1);
  assert.throws(() => validatePage(page, 2));
  assert.throws(() => validatePage({ ...page, nextCursor: 1 }, 1));
  assert.throws(() => validatePage({ ...page, deletedOrders: [], nextCursor: 1, hasMore: true }, 1));
  validatePage({ ...page, deletedOrders: [], nextCursor: 1 }, 1);
});
test('all source states produce BS orders without inventing payment for unpaid orders', () => {
  for (const status of ['pending', 'cancelled', 'refunded', 'delivered']) {
    const payload = buildBsOrder(order({ status, payment: { status: 'unpaid', paidAmount: null, paidAt: null } }), 1, 90);
    assert.equal(payload.prepay, 0);
    assert.ok(payload.goodsPositions.length);
    assert.ok(payload.internalComments.includes(status));
  }
});
test('BS conversion preserves full total including shipping, discounts and actual payment', () => {
  const source = order(); source.items[0].qty = 3; source.pricing.discount = 10; source.pricing.total -= 10;
  source.payment.paidAmount = 50;
  const payload = buildBsOrder(source, 123, 93.123456);
  const actualCents = payload.goodsPositions.reduce((s, p) => s + Math.round(p.price * 100) * p.quantity, 0);
  assert.equal(actualCents, Math.round(source.pricing.total * 93.123456 * 100));
  assert.equal(payload.goodsPositions.filter(p => p.goods.id === 486959).reduce((s, p) => s + p.quantity, 0), 3);
  assert.equal(payload.prepay, Math.round(50 * 93.123456 * 100) / 100);
  assert.equal(payload.orderStatus.name, 'Новый (ждем фото)');
  assert.equal(markerId(payload.internalComments), source.id);
  assert.equal(payload.customFields, undefined);
  assert.equal(payload.externalNumber, undefined);
  assert.equal(payload.internalNumber, undefined);
});
test('rate is cached for an hour; API failure uses 90 instead of stale successful rate', async t => {
  let calls = 0;
  t.mock.method(global, 'fetch', async () => { calls++; return { ok: true, json: async () => ({ Valute: { EUR: { Value: 930, Nominal: 10 } } }) }; });
  const rates = new EurRateService(config());
  assert.equal((await rates.current()).rate, 93);
  assert.equal((await rates.current()).rate, 93); assert.equal(calls, 1);
  rates.checkedAt = Date.now() - 3600_001;
  global.fetch = async () => { throw new Error('offline'); };
  assert.deepEqual(await rates.current(), { rate: 90, source: 'fallback' });
});
test('malformed exchange-rate response uses fallback', async t => {
  t.mock.method(global, 'fetch', async () => ({ ok: true, json: async () => ({ Valute: { EUR: { Value: 90, Nominal: 0 } } }) }));
  assert.equal((await new EurRateService(config()).current()).rate, 90);
});
test('adding Spain preserves all existing customer tags', async () => {
  const requests = [];
  const bs = new MetavistaBsService({ send: async (...args) => { requests.push(args); } }, { bluesalesTag: { upsert: async () => {} } }, config());
  await bs.ensureTag({ id: 42, tags: [{ id: 1 }, { id: 2 }] }, 3);
  assert.deepEqual(requests[0][1], { id: 42, tags: [{ id: 1 }, { id: 2 }, { id: 3 }] });
  await bs.ensureTag({ id: 42, tags: [{ id: 3 }] }, 3);
  assert.equal(requests.length, 1);
});
test('customer lookup uses normalized local email and never calls BlueSales, including misses and conflicts', async () => {
  let leads = [{ bsCustomerId: 2 }], previous = [], query;
  const bs = new MetavistaBsService({ send: async () => assert.fail('No API calls during lookup') }, {
    lead: { findMany: async args => { query = args; return leads; } },
    $queryRaw: async () => previous,
  }, config());
  const source = order(); source.customer.email = '  METAVISTA-TEST@example.invalid ';
  assert.deepEqual(await bs.findCustomer(source), { id: 2 });
  assert.deepEqual(query.where, { email: 'metavista-test@example.invalid', bsCustomerId: { not: null } });
  assert.equal(query.take, 2);
  previous = [{ bsCustomerId: 2, uncertain: false }];
  assert.deepEqual(await bs.findCustomer(source), { id: 2 }, 'same ID from both sources is not ambiguous');
  leads = [];
  assert.deepEqual(await bs.findCustomer(source), { id: 2 }, 'reuse saved export after interrupted lead save');
  previous = [];
  assert.equal(await bs.findCustomer(source), null);
  leads = [{ bsCustomerId: 1 }, { bsCustomerId: 2 }];
  await assert.rejects(bs.findCustomer(source), /Несколько клиентов/);
  leads = [{ bsCustomerId: 1 }]; previous = [{ bsCustomerId: 2, uncertain: false }];
  await assert.rejects(bs.findCustomer(source), /Несколько клиентов/);
  leads = []; previous = [{ bsCustomerId: null, uncertain: true }];
  await assert.rejects(bs.findCustomer(source), /Автоповтор запрещён/);
  source.customer.email = ' ';
  await assert.rejects(bs.findCustomer(source), /Не указан email/);
});

test('customer refresh performs exactly one targeted request and fails if that ID is missing', async () => {
  const requests = [];
  const bs = new MetavistaBsService({ send: async (method, data) => {
    requests.push({ method, data });
    return { customers: [{ id: 2 }], notReturnedCount: 1000 };
  } }, {}, config());
  assert.equal((await bs.customer(2)).id, 2);
  assert.deepEqual(requests, [{ method: 'customers.get', data: { ids: [2], pageSize: 1, startRowNumber: 0 } }]);
  await assert.rejects(bs.customer(3), /Клиент БС не найден/);
  assert.equal(requests.length, 2);
});
test('Metavista HTTP request keeps bearer server-side and honors Retry-After', async t => {
  const service = new MetavistaService({}, config({ METAVISTA_API_KEY: 'secret-test' }), {}, {}, {});
  service.assertLock = async () => {};
  t.mock.method(global, 'fetch', async (url, options) => {
    assert.equal(url, 'https://metavista.es/api/integrations/crm/v1/status');
    assert.equal(options.headers.Authorization, 'Bearer secret-test');
    assert.equal(options.redirect, 'error');
    return { ok: false, status: 429, headers: new Headers({ 'Retry-After': '120' }) };
  });
  await assert.rejects(service.request('/status'), /429/);
  assert.ok(service.retryAfter >= Date.now() + 119_000);
  await assert.rejects(service.request('/status'), /Retry-After/);
  assert.equal(service.errorMessage(new Error('secret-test leaked')), '[redacted] leaked');
});

test('verified tag/status and operational settings cannot be overridden by old env entries', () => {
  const settings = metavistaConfig(config({ METAVISTA_BS_TAG_ID: '1', METAVISTA_BS_TAG: 'wrong', METAVISTA_BS_STATUS: 'wrong', METAVISTA_EUR_FALLBACK_RUB: '1' }));
  assert.equal(settings.tagId, 728420); assert.equal(settings.tagName, 'ИСПАНИЯ');
  assert.equal(settings.statusId, 145338); assert.equal(settings.statusName, 'Новый (ждем фото)');
  assert.equal(settings.fallbackRate, 90);
});
test('mapping uses exact saved dimensions in either orientation, never size labels', () => {
  const item = order().items[0];
  assert.equal(matchingGoodsId(item), 486959);
  assert.equal(matchingGoodsId({ ...item, spec: 'XL · 80 × 60 cm · Horizontal' }), 486961);
  assert.equal(matchingGoodsId({ ...item, spec: 'L · 61 × 45,7 cm · Horizontal' }), null);
  assert.equal(matchingGoodsId({ ...item, spec: 'L' }), null);
  assert.equal(matchingGoodsId({ ...item, configuration: { widthCm: 60, heightCm: 40 } }), 486960);
  assert.equal(matchingGoodsId({ ...item, configuration: { widthCm: 61, heightCm: 45.7 } }), null);
  assert.equal(matchingGoodsId({ ...item, productId: 'unknown-product' }), null);
});
test('unknown items and shipping are omitted as lines but their value stays in the full BS total', () => {
  const source = order();
  source.items.push({ ...source.items[0], id: 2, productId: 'unknown-product', name: 'Unsupported', lineSubtotal: 28, lineTotal: 28 });
  source.pricing = { currency: 'EUR', subtotal: 100, discount: 10, shipping: 10, total: 100 };
  source.payment.paidAmount = 100;
  const selected = selectMappedOrder(source);
  assert.equal(selected.items.length, 1);
  assert.equal(selected.pricing.total, 100);
  assert.equal(selected.payment.paidAmount, 100);
  assert.equal(selected.sourceAmounts.total, 100);
  assert.deepEqual(selectMappedOrder(selected), selected);
  const payload = buildBsOrder(source, 1, 90);
  assert.equal(payload.goodsPositions.reduce((sum, p) => sum + p.quantity * p.price, 0), 9000);
  assert.ok(payload.internalComments.includes('Unsupported'), 'source composition is retained in the creation note');
  assert.ok(payload.goodsPositions.every(p => p.goods.id === 486959));
  assert.equal(source.items.length, 2, 'source must not be mutated');
});

test('full amount is restored from snapshots saved under the previous partial-total policy', () => {
  const saved = order();
  saved.pricing.total = 64.8; saved.pricing.shipping = 0; saved.payment.paidAmount = 64.8;
  saved.sourceAmounts = { total: 100, shipping: 10, paidAmount: 80 };
  const payload = buildBsOrder(saved, 1, 90);
  assert.equal(payload.goodsPositions.reduce((sum, p) => sum + p.quantity * p.price, 0), 9000);
  assert.equal(payload.prepay, 7200);
});

test('zero-price matched products still carry the full amount and preserve quantities and kopecks', () => {
  const source = order();
  source.items[0].lineTotal = 0; source.items[0].qty = 3;
  source.items.push({ ...source.items[0], id: 2, spec: '60 × 80', qty: 2 });
  source.payment.paidAmount = null;
  const payload = buildBsOrder(source, 1, 93.123456);
  const total = Math.round(source.pricing.total * 93.123456 * 100);
  assert.equal(payload.goodsPositions.reduce((sum, p) => sum + Math.round(p.price * 100) * p.quantity, 0), total);
  assert.equal(payload.goodsPositions.reduce((sum, p) => sum + p.quantity, 0), 5);
  assert.equal(payload.prepay, total / 100);
});

test('orders with no matched products use the verified general print product and full total', () => {
  const source = order(); source.items[0].spec = '61 × 45,7';
  const payload = buildBsOrder(source, 1, 90);
  assert.deepEqual(payload.goodsPositions, [{ goods: { id: 493830 }, price: 7371, quantity: 1 }]);
});
