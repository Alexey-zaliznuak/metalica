const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
require('reflect-metadata');
const { Module, ValidationPipe } = require('@nestjs/common');
const { NestFactory } = require('@nestjs/core');
const { JwtService } = require('@nestjs/jwt');
const { JwtStrategy } = require('../dist/auth/jwt.strategy');
const { PrismaService } = require('../dist/prisma/prisma.service');
const { BluesalesApiService } = require('../dist/bluesales/bluesales-api.service');
const { CdekDeliveryPricesController } = require('../dist/orders/cdek-delivery-prices.controller');

test('автоматическая сверка стоимости через HTTP Metallity', async t => {
  const from = '2020-11-22T12:00:00Z';
  const vars = { JWT_SECRET: 'local-price-test', CDEK_DELIVERY_PRICE_FROM_UTC: from };
  const saved = Object.fromEntries(Object.keys(vars).map(k => [k, process.env[k]]));
  Object.assign(process.env, vars);
  t.after(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  });
  const track = '00123456789';
  const trackingField = value => ({ fieldName: 'Сдэк трек', value });
  const current = new Date('2020-11-25T00:00:00Z');
  const field = text => ({ fieldId: 7358, fieldName: 'Сверка доставки СДЭК', value: text });
  function data() {
    return { orderNumber: '29647328', source: 'BLUESALES', createdAt: current, bluesalesInfo: {
      bsOrderId: 101, bsCreatedAt: current, lastSyncedAt: current, rawPayload: {
        id: 101, date: '25.11.2020', deliveryPrice: '650.00', deliveryService: { id: 5 }, trackingNumber: track,
        customFields: [trackingField(track)],
      },
    } };
  }
  let order, duplicate, page, writes, queryDb;
  const prisma = {
    user: { findUnique: async ({ where }) => ({ id: where.id, role: where.id === 1 ? 'ADMIN' : 'MANAGER' }) },
    order: {
      findUnique: async ({ where }) => where.id === 1 ? order : null,
      findFirst: async () => ({ id: page.at(-1) ?? 0 }),
      findMany: async ({ where, take }) => {
        assert.equal(where.source, 'BLUESALES');
        assert.equal(where.createdAt.gt.toISOString(), new Date(from).toISOString());
        assert.deepEqual(where.bluesalesInfo.is.bsCreatedAt, where.createdAt);
        assert.deepEqual(where.bluesalesInfo.is.OR, [{ orderStatusId: null }, { orderStatusId: { notIn: [145342, 145343, 174993] } }]);
        return page.filter(i => i > where.id.gt && i <= where.id.lte).slice(0, take).map(id => ({ id }));
      },
    },
    $queryRaw: async sql => queryDb ? (await queryDb.query(sql.text, sql.values)).rows
      : duplicate && sql.text.includes('v AS value') ? [{ orderNumber: '29649999', value: track }] : [],
  };
  const bridge = { setOrderCustomField: async (...args) => writes.push(args) };
  class LocalTestModule {}
  Module({ controllers: [CdekDeliveryPricesController], providers: [JwtStrategy,
    { provide: PrismaService, useValue: prisma }, { provide: BluesalesApiService, useValue: bridge },
  ] })(LocalTestModule);
  const app = await NestFactory.create(LocalTestModule, { logger: false });
  t.after(() => app.close());
  app.setGlobalPrefix('api');
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  await app.listen(0, '127.0.0.1');
  const base = (await app.getUrl()) + '/api';
  const jwt = new JwtService({ secret: vars.JWT_SECRET });
  const admin = jwt.sign({ sub: 1 });
  function reset() { order = data(); page = [1]; duplicate = false; writes = []; }
  function req(path = '/1', body, token = admin) {
    return fetch(base + '/cdek/delivery-prices' + path, { method: body ? 'PUT' : 'GET',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: JSON.stringify(body) });
  }
  const payload = { bsOrderId: 101, tracking: track, quotedKopecks: 65000, carrierKopecks: 115000, previousValue: null };
  await t.test('авторизация, дата активации, часовой пояс и поздний импорт', async () => {
    reset();
    assert.equal((await req('/1', undefined, '')).status, 401);
    assert.equal((await req('/1', payload, jwt.sign({ sub: 2 }))).status, 403);
    delete process.env.CDEK_DELIVERY_PRICE_FROM_UTC;
    assert.equal((await req('')).status, 404);
    process.env.CDEK_DELIVERY_PRICE_FROM_UTC = '2026-02-31T00:00:00Z';
    assert.equal((await req('')).status, 409);
    process.env.CDEK_DELIVERY_PRICE_FROM_UTC = '2999-01-01T00:00:00Z';
    assert.equal((await req('?existingBefore=0')).status, 404);
    process.env.CDEK_DELIVERY_PRICE_FROM_UTC = from;
    order.bluesalesInfo.bsCreatedAt = new Date('2020-11-22T14:59:59Z');
    order.bluesalesInfo.rawPayload.date = '22.11.2020 14:59:59';
    assert.equal((await req('/1', payload)).status, 404);
    assert.equal((await (await req('/1?includeExisting=1')).json()).scope, 'existing');
    order.bluesalesInfo.bsCreatedAt = new Date('2020-11-22T15:00:01Z');
    order.bluesalesInfo.rawPayload.date = '22.11.2020 15:00:01';
    assert.equal((await req()).status, 200);
    assert.equal((await (await req('/1?includeExisting=1')).json()).scope, 'new');
    order.createdAt = new Date(from);
    assert.equal((await req('/1', payload)).status, 404);
    assert.equal(writes.length, 0);
  });
  await t.test('ожидающие подходят, выданные и возвраты исключены для обеих очередей даже при смене статуса перед записью', async () => {
    reset();
    for (const scope of ['existing', 'new']) {
      order.bluesalesInfo.bsCreatedAt = scope === 'existing' ? null : current;
      const body = scope === 'existing' ? { ...payload, existingBeforeHandover: true } : payload;
      order.bluesalesInfo.orderStatusId = 174764;
      assert.equal((await (await req('/1?includeExisting=1')).json()).scope, scope);
      assert.equal((await req('/1', body)).status, 200);
      for (const id of [145342, 145343, 174993]) {
        order.bluesalesInfo.orderStatusId = id;
        assert.equal((await req('/1', body)).status, 404);
        assert.equal((await req('/1?includeExisting=1')).status, 404);
      }
    }
    assert.equal(writes.length, 2);
  });
  await t.test('постраничный обход с фиксированной верхней границей', async () => {
    reset();
    page = Array.from({ length: 26 }, (_, i) => i + 1);
    const first = await (await req('')).json();
    assert.equal(first.ids.length, 25);
    assert.equal(first.nextAfter, 25);
    page.push(27);
    assert.deepEqual(await (await req('?after=25&maxId=26')).json(), { ids: [26], maxId: 26, nextAfter: null });
    assert.equal((await req('?after=-1')).status, 400);
  });
  await t.test('пустая цена, бесплатная доставка и однозначность трека', async () => {
    reset();
    const raw = order.bluesalesInfo.rawPayload;
    raw.deliveryService = 2;
    raw.customFields = [];
    delete raw.deliveryPrice;
    const result = await (await req()).json();
    assert.equal(result.tracking, null);
    assert.equal(result.quotedKopecks, null);
    assert.equal(result.fieldId, 7358);
    raw.customFields.push({ fieldName: 'Заказ.Сдэк трек', valueAsText: track });
    raw.deliveryPrice = 0;
    assert.equal((await (await req()).json()).quotedKopecks, 0);
    assert.equal((await (await req()).json()).tracking, track);
    raw.deliveryPrice = '650,9900';
    assert.equal((await (await req()).json()).quotedKopecks, 65099);
    raw.deliveryService = 5;
    raw.postTrackingNumber = '999';
    assert.equal((await (await req()).json()).tracking, track);
    delete raw.postTrackingNumber;
    raw.id = 555;
    assert.equal((await req()).status, 409);
  });
  await t.test('номер текущего заказа по обе стороны дроби, чужие номера и пустое поле', async () => {
    reset();
    const raw = order.bluesalesInfo.rawPayload;
    raw.customFields = [];
    assert.equal((await (await req()).json()).tracking, null);
    assert.equal((await req('/1', payload)).status, 409);
    const accepted = [track + '/ 29647328', ' 29647328 / ' + track + ' ', track+' 29647328',
      track+'слово', 'накладная №'+track, track+' / комментарий', track+' от 25/11', track+' 29647328 с наложкой'];
    for (const text of accepted) {
      raw.customFields = [trackingField(text)];
      assert.equal((await (await req()).json()).tracking, track);
      assert.equal((await req('/1', payload)).status, 200);
    }
    for (const text of ['29645445/'+track, '29647328/29647328', track+'/29647328/1','29647328 / нет',
      'номер '+'1'.repeat(41), track+' 29645445 наложка', track+' и 00022334455', 'от 25/11']) {
      raw.customFields = [trackingField(text)];
      assert.equal((await req()).status, 409);
      assert.equal((await req('/1', payload)).status, 409);
    }
    assert.equal(writes.length, accepted.length);
  });
  await t.test('копейки, подтверждение импорта, защита ручного текста и устаревшего расчёта', async () => {
    reset();
    for (const [delta, expected] of [[49999, '✓ Разница +499,99 ₽'], [50000, '🔴 Разница +500,00 ₽'],
      [-50000, '🔴 Разница -500,00 ₽'], [0, '✓ Разница 0,00 ₽']]) {
      const body = { ...payload, carrierKopecks: 65000 + delta };
      assert.deepEqual(await (await req('/1', body)).json(), { state: 'awaiting_sync', value: expected });
      assert.deepEqual(writes.at(-1), [101, 7358, expected, 'background']);
      order.bluesalesInfo.rawPayload.customFields = [trackingField(track), field(expected)];
      assert.equal((await (await req('/1', body)).json()).state, 'confirmed');
      order.bluesalesInfo.rawPayload.customFields = [trackingField(track)];
    }
    for (const diff of [{ bsOrderId: 102 }, { tracking: '555' }, { quotedKopecks: 64123 }, { previousValue: 'текст' }]) {
      assert.equal((await req('/1', { ...payload, ...diff })).status, 409);
    }
    assert.equal((await req('/1', { ...payload, carrierKopecks: 1.5 })).status, 400);
    order.bluesalesInfo.rawPayload.customFields = [trackingField(track), field('Комментарий')];
    assert.equal((await req('/1', { ...payload, previousValue: 'Комментарий' })).status, 409);
    order.bluesalesInfo.rawPayload.customFields = [trackingField(track)];
    duplicate = true;
    assert.equal((await req('/1', payload)).status, 409);
    assert.equal(writes.length, 4);
  });
  await t.test('SQL на PostgreSQL проверяет совпадения в исторических карточках', { skip: !process.env.PRICE_QA_PGLITE }, async () => {
    reset();
    const { PGlite } = require(process.env.PRICE_QA_PGLITE);
    queryDb = new PGlite();
    try {
      await queryDb.exec('CREATE TABLE "BluesalesOrderInfo" ("orderId" int, "rawPayload" jsonb)');
      await queryDb.exec(`CREATE TABLE "Order" (id int PRIMARY KEY, "orderNumber" text);
        INSERT INTO "Order" VALUES (1,'29647328'),(2,'29645678'),(3,'29649999');`);
      async function insert(id, raw) {
        await queryDb.query('INSERT INTO "BluesalesOrderInfo" VALUES ($1, $2)', [id, JSON.stringify(raw)]);
      }
      await insert(1, order.bluesalesInfo.rawPayload);
      await insert(2, { deliveryService: 5, postTrackingNumber: track, trackingNumber: track, customFields: null });
      assert.equal((await req('/1', payload)).status, 200);
      for (const raw of [{ customFields: [trackingField(track+' / 29649999')] },
        { customFields: [trackingField('29649999/ '+track)] },
        { customFields: [trackingField('29649999 '+track+' наложка')] },
        { customFields: [trackingField(track+' наложка 25/11')] },
        { customFields: [{ name: 'Заказ.Сдэк трек', value: track }] },
        { customFields: [{ fieldName: 'Сдэк трек', valueAsText: track }] }]) {
        await insert(3, raw);
        assert.equal((await req('/1', payload)).status, 409);
        await queryDb.exec('DELETE FROM "BluesalesOrderInfo" WHERE "orderId" = 3');
      }
      assert.equal(writes.length, 1);
    } finally { await queryDb.close(); queryDb = undefined; }
  });
  await t.test('PostgreSQL: старые с треком, поздний импорт и независимые страницы', { skip: !process.env.PRICE_QA_PGLITE }, async () => {
    reset();
    const { PGlite } = require(process.env.PRICE_QA_PGLITE);
    queryDb = new PGlite();
    try {
      await queryDb.exec(`CREATE TABLE "Order" (id int PRIMARY KEY, source text, "createdAt" timestamp);
        CREATE TABLE "BluesalesOrderInfo" ("orderId" int, "orderStatusId" int, "bsCreatedAt" timestamp, "rawPayload" jsonb);
        INSERT INTO "Order" SELECT i,'BLUESALES','2020-11-25'::timestamp FROM generate_series(1,30) i;
        INSERT INTO "BluesalesOrderInfo" SELECT i,NULL,'2020-11-10'::timestamp,
          jsonb_build_object('customFields',jsonb_build_array(jsonb_build_object('fieldName','Сдэк трек','value',i::text))) FROM generate_series(1,30) i;
        UPDATE "BluesalesOrderInfo" SET "orderStatusId" = 145342 WHERE "orderId" = 30;
        UPDATE "BluesalesOrderInfo" SET "orderStatusId" = 174764 WHERE "orderId" = 26;
        UPDATE "BluesalesOrderInfo" SET "bsCreatedAt" = '2020-11-25' WHERE "orderId" = 29;
        UPDATE "BluesalesOrderInfo" SET "rawPayload" = '{"deliveryService":2,"postTrackingNumber":"123"}' WHERE "orderId" = 28;
        UPDATE "Order" SET source = 'MANUAL' WHERE id = 27;
        UPDATE "BluesalesOrderInfo" SET "bsCreatedAt" = '2020-11-22 14:59:59',
          "rawPayload" = '{"date":"22.11.2020 14:59:59","customFields":[{"name":"Сдэк трек","valueAsText":"0123"}]}' WHERE "orderId" = 26;`);
      const first = await (await req('?existingBefore=0')).json();
      assert.deepEqual(first.ids, Array.from({ length: 25 }, (_, i) => 26 - i));
      assert.equal(first.nextBefore, 2);
      assert.deepEqual(await (await req('?existingBefore=2')).json(), { ids: [1], nextBefore: null });
      await queryDb.exec(`UPDATE "BluesalesOrderInfo" SET "rawPayload" = '{"deliveryService":5,"postTrackingNumber":"456"}' WHERE "orderId" = 28`);
      assert.equal((await (await req('?existingBefore=0')).json()).ids[0], 26);
      await queryDb.exec(`UPDATE "BluesalesOrderInfo" SET "rawPayload" = '{"customFields":[{"name":"Сдэк трек","value":"28 / 456"}]}' WHERE "orderId" = 28`);
      assert.equal((await (await req('?existingBefore=0')).json()).ids[0], 28);
    } finally { await queryDb.close(); queryDb = undefined; }
  });
  await t.test('Python-обработчик проходит всю цепочку через локальный HTTP сайта', { skip: !process.env.PRICE_QA_WORKER }, async () => {
    reset();
    const script = [
      'import os, sqlite3, json', 'import cdek_notify.crm as crm',
      'from unittest.mock import Mock', 'from cdek_notify.price_sync import run_prices',
      "crm.BASE=os.environ['QA_SITE']", "site=crm.Metallity({'CRM_LOGIN':'local','CRM_PASSWORD':'local'})",
      "site.token=os.environ['QA_TOKEN']", 'cdek=Mock()',
      "cdek.order.return_value={'cdek_number':'00123456789','delivery_detail':{'delivery_sum':1120},'packages':[{'items':[{'amount':1,'payment':{'value':1000}}]}]}",
      "cdek.order.return_value['statuses']=[{'code':os.environ['QA_STATUS'],'date_time':'2020-11-10T11:00:00Z'}]",
      "print(json.dumps(run_prices(site,cdek,db=sqlite3.connect(':memory:'))['counts']))",
    ].join('\n');
    async function batch(status) {
      const child = await promisify(execFile)(process.env.PRICE_QA_PYTHON || 'python', ['-B', '-X', 'utf8', '-c', script],
        { cwd: process.env.PRICE_QA_WORKER, env: { ...process.env, QA_TOKEN: admin, QA_SITE: base, QA_STATUS: status } });
      return JSON.parse(child.stdout);
    }
    order.bluesalesInfo.orderStatusId = 174764;
    assert.deepEqual(await batch('ACCEPTED_AT_PICK_UP_POINT'), { awaiting_sync: 1 });
    assert.deepEqual(await batch('DELIVERED'), { shipment_closed: 1 });
    assert.deepEqual(writes, [[101, 7358, '🔴 Разница +500,00 ₽', 'background']]);
    // Drive the same normal batch entry point for an existing shipment.
    order.bluesalesInfo.bsCreatedAt = new Date('2020-11-01T00:00:00Z');
    page = [];
    const oldQuery = prisma.$queryRaw;
    prisma.$queryRaw = async sql => sql.text.includes('ORDER BY o.id DESC') ? [{ id: 1 }] : oldQuery(sql);
    try {
      for (const [code, expectedState] of [['SENT_TO_RECIPIENT_CITY', 'awaiting_sync'], ['ACCEPTED_AT_PICK_UP_POINT', 'awaiting_sync'],
        ['POSTOMAT_POSTED', 'awaiting_sync'], ['POSTOMAT_RECEIVED', 'shipment_closed'], ['DELIVERED', 'shipment_closed']]) {
        assert.deepEqual(await batch(code), { [expectedState]: 1 });
      }
      assert.equal(writes.length, 4);
    } finally { prisma.$queryRaw = oldQuery; }
  });
});
