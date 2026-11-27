const { test } = require('node:test');
const assert = require('node:assert/strict');
require('reflect-metadata');
const { Module, ValidationPipe } = require('@nestjs/common');
const { NestFactory } = require('@nestjs/core');
const { JwtService } = require('@nestjs/jwt');
const { JwtStrategy } = require('../dist/auth/jwt.strategy');
const { PrismaService } = require('../dist/prisma/prisma.service');
const { BluesalesApiService } = require('../dist/bluesales/bluesales-api.service');
const { CdekDeliveryCheckController } = require('../dist/orders/cdek-delivery-check.controller');

test('сверка доставки через HTTP сайта на локальных данных', async t => {
  const orderId = 16310;
  const bsOrderId = 12870788;
  const fieldId = 65001; // Вымышленный ID текстового поля.
  const fieldName = 'Сверка доставки СДЭК';
  const expected = '🔴 Разница +500,00 ₽';
  let fields;
  let writes;
  let failWrite;
  const saved = {};
  for (const key of ['CDEK_DELIVERY_CHECK_TEST_BS_ORDER_ID', 'CDEK_DELIVERY_CHECK_FIELD_ID', 'JWT_SECRET']) {
    saved[key] = process.env[key];
  }
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  process.env.JWT_SECRET = 'test-session-on-loopback';
  const prisma = {
    user: { findUnique: async ({ where }) => ({ id: where.id, role: where.id === 1 ? 'ADMIN' : 'MANAGER' }) },
    order: { findUnique: async ({ where }) => ({
      orderNumber: '29648829', source: 'BLUESALES', bluesalesInfo: {
        bsOrderId: where.id === orderId ? bsOrderId : bsOrderId + 1,
        rawPayload: { customFields: fields }, lastSyncedAt: new Date('2026-11-26T09:00:00Z'),
      },
    }) },
  };
  const bridge = { setOrderCustomField: async (...args) => {
    writes.push(args);
    if (failWrite) throw new Error('test bridge unavailable');
  } };
  class FixtureModule {}
  Module({ controllers: [CdekDeliveryCheckController], providers: [
    JwtStrategy, { provide: PrismaService, useValue: prisma },
    { provide: BluesalesApiService, useValue: bridge },
  ] })(FixtureModule);
  const app = await NestFactory.create(FixtureModule, { logger: false });
  t.after(() => app.close());
  app.setGlobalPrefix('api');
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  await app.listen(0, '127.0.0.1');
  const base = await app.getUrl();
  const jwt = new JwtService({ secret: process.env.JWT_SECRET });
  const admin = jwt.sign({ sub: 1 });
  const manager = jwt.sign({ sub: 2 });
  function request({ body, id = orderId, token = admin } = {}) {
    return fetch(base + '/api/orders/' + id + '/cdek-delivery-check', {
      method: body === undefined ? 'GET' : 'PUT',
      headers: { 'Content-Type': 'application/json', ...(token && { Authorization: 'Bearer ' + token }) },
      body: JSON.stringify(body),
    });
  }
  const write = (differenceKopecks = 50_000, extra = {}) => request({ body: { differenceKopecks }, ...extra });
  function reset() {
    process.env.CDEK_DELIVERY_CHECK_TEST_BS_ORDER_ID = String(bsOrderId);
    delete process.env.CDEK_DELIVERY_CHECK_FIELD_ID;
    fields = [{ fieldId, fieldName, valueAsText: '' }, { fieldId: 42, fieldName: 'Доставка', value: '650' }];
    writes = [];
    failWrite = false;
  }

  await t.test('только поле сверки; подтверждение после обычной синхронизации', async () => {
    reset();
    assert.equal((await (await request()).json()).value, null);
    const submitted = await write();
    assert.equal(submitted.status, 200);
    assert.deepEqual(await submitted.json(), { state: 'awaiting_sync', value: expected });
    assert.deepEqual(writes, [[bsOrderId, fieldId, expected, 'interactive']]);
    assert.equal((await (await request()).json()).value, null);
    fields[0].valueAsText = expected; // Так очередной штатный импорт обновит копию.
    const snapshot = await (await request()).json();
    assert.equal(snapshot.value, expected);
    assert.equal(snapshot.orderNumber, '29648829');
    assert.deepEqual(await (await write()).json(), { state: 'confirmed', value: expected });
    assert.equal(writes.length, 1);
    assert.equal(fields[1].value, '650');
  });
  await t.test('авторизация, привязка заказа и отключение по умолчанию', async () => {
    reset();
    assert.equal((await request({ token: '' })).status, 401);
    assert.equal((await write(8000, { token: manager })).status, 403);
    assert.equal((await write(8000, { id: orderId + 1 })).status, 404);
    delete process.env.CDEK_DELIVERY_CHECK_TEST_BS_ORDER_ID;
    assert.equal((await write()).status, 404);
    assert.equal(writes.length, 0);
  });
  await t.test('для пропущенного при импорте поля нужен настроенный ID', async () => {
    reset();
    fields = [];
    assert.equal((await write()).status, 409);
    process.env.CDEK_DELIVERY_CHECK_FIELD_ID = String(fieldId);
    assert.equal((await write()).status, 200);
    assert.deepEqual(writes, [[bsOrderId, fieldId, expected, 'interactive']]);
  });
  await t.test('конфликты ID, названия, типа или уже записанного значения', async () => {
    reset();
    process.env.CDEK_DELIVERY_CHECK_FIELD_ID = String(fieldId);
    for (const bad of [
      [{ fieldId: fieldId + 1, fieldName }],
      [{ fieldId, fieldName: 'Другая сверка' }],
      [{ fieldId, fieldName }, { fieldId: fieldId + 1, fieldName }],
      [{ fieldId, fieldName, value: 42 }],
      [{ fieldId, fieldName, value: 'Значение менеджера' }],
    ]) {
      fields = bad;
      assert.equal((await write()).status, 409);
    }
    assert.equal(writes.length, 0);
  });
  await t.test('красная отметка от 500 рублей включительно в обе стороны', async () => {
    reset();
    for (const [kopecks, label] of [[0, '✓ Разница 0,00 ₽'], [8000, '✓ Разница +80,00 ₽'],
      [49999, '✓ Разница +499,99 ₽'], [50000, expected], [50001, '🔴 Разница +500,01 ₽'],
      [-49999, '✓ Разница -499,99 ₽'], [-50000, '🔴 Разница -500,00 ₽'], [-50001, '🔴 Разница -500,01 ₽']]) {
      assert.equal((await (await write(kopecks)).json()).value, label);
    }
    for (const value of [null, 1.5, '80.00', Number.MAX_SAFE_INTEGER + 1]) {
      assert.equal((await write(value)).status, 400);
    }
    assert.equal(writes.length, 8);
  });
  await t.test('явная замена тестовой метки только согласованной суммой', async () => {
    reset();
    const body = { differenceKopecks: 50_000, replaceTestMarker: true };
    for (const value of ['', 'Значение менеджера', 'ТЕСТ СВЕРКИ изменён', '🔴 Разница +81,00 ₽']) {
      fields[0].valueAsText = value;
      assert.equal((await request({ body })).status, 409);
    }
    fields[0].valueAsText = 'ТЕСТ СВЕРКИ';
    assert.equal((await write()).status, 409);
    assert.equal((await request({ body: { ...body, differenceKopecks: 7900 } })).status, 409);
    assert.equal(writes.length, 0);
    assert.deepEqual(await (await request({ body })).json(), { state: 'awaiting_sync', value: expected });
    assert.deepEqual(writes, [[bsOrderId, fieldId, expected, 'interactive']]);
    fields[0].valueAsText = '🔴 Разница +80,00 ₽';
    assert.equal((await request({ body: { ...body, differenceKopecks: 8000 } })).status, 409);
    assert.deepEqual(await (await request({ body })).json(), { state: 'awaiting_sync', value: expected });
    assert.deepEqual(writes[1], [bsOrderId, fieldId, expected, 'interactive']);
  });
  await t.test('ошибка обмена не подтверждает запись', async () => {
    reset();
    failWrite = true;
    assert.equal((await write()).status, 500);
    assert.equal((await (await request()).json()).value, null);
    assert.equal(writes.length, 1);
  });
});
