// Run after npm run build: node --test test/order-assets.test.cjs
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { validate } = require('class-validator');
const { OrdersService } = require('../dist/orders/orders.service');
const { UpdateOrderDto } = require('../dist/orders/dto/update-order.dto');
const { MAX_UPLOAD_BYTES } = require('../dist/storage/upload.config');

const actor = { id: 1, role: 'MANAGER', scopes: [] };

function setup({ photo = null, stat = { size: 123, mimeType: 'image/jpeg' } } = {}) {
  const existing = { id: 10, finalSketchMessageId: 20, printPhoto: photo };
  const writes = [];
  const events = [];
  const prisma = {
    order: {
      findUnique: async () => existing,
      update: async (input) => { writes.push(input); return existing; },
    },
    message: {
      findFirst: async ({ where }) => where.orderId === 10 && where.id === 21 ? { id: 21 } : null,
    },
  };
  const service = new OrdersService(
    prisma, { record: async (...args) => events.push(args) }, null, null,
    { stat: async () => stat }, null, null, null,
  );
  service.findOne = async () => existing;
  return { service, writes, events };
}

test('a message from another order cannot become the final sketch', async () => {
  const { service, writes } = setup();
  await assert.rejects(service.update(10, { finalSketchMessageId: 99 }, actor), /в этом заказе/);
  assert.equal(writes.length, 0);
});

test('replacing and clearing the sketch updates the single order relation', async () => {
  const { service, writes, events } = setup();
  await service.update(10, { finalSketchMessageId: 21 }, actor);
  await service.update(10, { finalSketchMessageId: null }, actor);
  assert.deepEqual(writes.map(({ data }) => data.finalSketchMessage), [
    { connect: { id: 21 } }, { disconnect: true },
  ]);
  assert.equal(events[0][2][0].field, 'finalSketchMessage');
});

test('failed photo validation leaves the previous photo intact', async () => {
  for (const stat of [null, { size: 10, mimeType: 'text/plain' }, { size: MAX_UPLOAD_BYTES + 1, mimeType: 'image/png' }]) {
    const { service, writes } = setup({ photo: { filename: 'old.jpg' }, stat });
    await assert.rejects(service.update(10, { printPhotoKey: 'new.txt' }, actor));
    assert.equal(writes.length, 0);
  }
});

test('photo replacement reuses one attachment and preserves storage metadata', async () => {
  const { service, writes } = setup({ photo: { filename: 'old.jpg' } });
  await service.update(10, { printPhotoKey: '2026-09-05/new.jpg' }, actor);
  const { create, update } = writes[0].data.printPhoto.upsert;
  assert.deepEqual(create, update);
  assert.equal(update.objectKey, '2026-09-05/new.jpg');
  assert.equal(update.size, 123);
  assert.equal(update.mimeType, 'image/jpeg');
  assert.equal(update.kind, 'print-photo');
});

test('HEIC, HEIF, PDF and DNG accept the same fallback extensions as chat', async () => {
  for (const extension of ['HEIC', 'heif', 'pdf', 'dng']) {
    const { service, writes } = setup({ stat: { size: 10, mimeType: 'application/octet-stream' } });
    await service.update(10, { printPhotoKey: `file.${extension}` }, actor);
    assert.equal(writes.length, 1);
  }
});

test('clearing an empty photo is safe, and unrelated updates leave both assets unchanged', async () => {
  const { service, writes } = setup();
  await service.update(10, { printPhotoKey: null }, actor);
  await service.update(10, { note: 'Примечание' }, actor);
  assert.equal(writes[0].data.printPhoto, undefined);
  assert.deepEqual(writes[1].data, { note: 'Примечание' });
  const attached = setup({ photo: { filename: 'old.jpg' } });
  await attached.service.update(10, { printPhotoKey: null }, actor);
  assert.deepEqual(attached.writes[0].data.printPhoto, { delete: true });
});

test('API rejects malformed asset values and permits explicit clearing', async () => {
  for (const payload of [
    { finalSketchMessageId: -1 }, { finalSketchMessageId: '21' },
    { finalSketchMessageId: 1.5 }, { printPhotoKey: [] }, { printPhotoKey: '' },
  ]) {
    assert.ok((await validate(Object.assign(new UpdateOrderDto(), payload))).length > 0);
  }
  assert.equal((await validate(Object.assign(new UpdateOrderDto(), {
    finalSketchMessageId: null, printPhotoKey: null,
  }))).length, 0);
});
