// Run after npm run build: node --test test/order-assets.test.cjs
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { validate } = require('class-validator');
const { OrdersService } = require('../dist/orders/orders.service');
const { UpdateOrderDto } = require('../dist/orders/dto/update-order.dto');
const { MAX_UPLOAD_BYTES } = require('../dist/storage/upload.config');

const actor = { id: 1, role: 'MANAGER', scopes: [] };

function setup({ photos = [], stat = { size: 123, mimeType: 'image/jpeg' } } = {}) {
  const existing = { id: 10, finalSketchMessageId: 20, printPhotos: photos };
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
    { stat: async (key) => typeof stat === 'function' ? stat(key) : stat }, null, null, null,
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

test('failed photo validation leaves previous photos intact', async () => {
  for (const stat of [null, { size: 10, mimeType: 'text/plain' }, { size: MAX_UPLOAD_BYTES + 1, mimeType: 'image/png' }]) {
    const { service, writes } = setup({ photos: [{ id: 1, filename: 'old.jpg' }], stat });
    await assert.rejects(service.update(10, { printPhotoKeys: ['new.txt'] }, actor));
    assert.equal(writes.length, 0);
  }
});

test('multiple photos append without replacing existing attachments', async () => {
  const { service, writes, events } = setup({ photos: [{ id: 1, filename: 'old.jpg' }] });
  await service.update(10, { printPhotoKeys: ['2026-09-05/one.jpg', '2026-09-05/two.jpg'] }, actor);
  const change = writes[0].data.printPhotos;
  assert.deepEqual(Object.keys(change), ['create']);
  assert.deepEqual(change.create.map((photo) => photo.objectKey), ['2026-09-05/one.jpg', '2026-09-05/two.jpg']);
  for (const photo of change.create) {
    assert.equal(photo.size, 123);
    assert.equal(photo.mimeType, 'image/jpeg');
    assert.equal(photo.kind, 'print-photo');
  }
  assert.equal(events[0][2][0].newValue, 'old.jpg, one.jpg, two.jpg');
});

test('invalid file in a batch prevents all attachment changes, including removal', async () => {
  const { service, writes } = setup({
    photos: [{ id: 1, filename: 'old.jpg' }],
    stat: (key) => key === 'missing.jpg' ? null : { size: 12, mimeType: 'image/jpeg' },
  });
  await assert.rejects(service.update(10, {
    printPhotoKeys: ['good.jpg', 'missing.jpg'], removePrintPhotoIds: [1],
  }, actor));
  assert.equal(writes.length, 0);
});

test('removing one photo targets only that order attachment', async () => {
  const { service, writes, events } = setup({ photos: [
    { id: 1, filename: 'one.jpg' }, { id: 2, filename: 'two.jpg' },
  ] });
  await service.update(10, { removePrintPhotoIds: [1] }, actor);
  assert.deepEqual(writes[0].data.printPhotos, { deleteMany: { id: { in: [1] } } });
  assert.equal(events[0][2][0].newValue, 'two.jpg');
  await assert.rejects(service.update(10, { removePrintPhotoIds: [999] }, actor), /в этом заказе/);
  assert.equal(writes.length, 1);
});

test('duplicate keys in a batch create one attachment per file', async () => {
  const { service, writes } = setup();
  await service.update(10, { printPhotoKeys: ['one.jpg', 'one.jpg'] }, actor);
  assert.equal(writes[0].data.printPhotos.create.length, 1);
});

test('HEIC, HEIF, PDF and DNG accept the same fallback extensions as chat', async () => {
  for (const extension of ['HEIC', 'heif', 'pdf', 'dng']) {
    const { service, writes } = setup({ stat: { size: 10, mimeType: 'application/octet-stream' } });
    await service.update(10, { printPhotoKeys: [`file.${extension}`] }, actor);
    assert.equal(writes.length, 1);
  }
});

test('empty arrays and unrelated updates leave existing photos unchanged', async () => {
  const { service, writes } = setup();
  await service.update(10, { printPhotoKeys: [], removePrintPhotoIds: [] }, actor);
  await service.update(10, { note: 'Примечание' }, actor);
  assert.equal(writes[0].data.printPhotos, undefined);
  assert.deepEqual(writes[1].data, { note: 'Примечание' });
});

test('API validates every key and removal ID and rejects null arrays', async () => {
  for (const payload of [
    { finalSketchMessageId: -1 }, { finalSketchMessageId: '21' },
    { finalSketchMessageId: 1.5 }, { printPhotoKeys: 'one.jpg' }, { printPhotoKeys: [''] },
    { printPhotoKeys: ['one.jpg', 1] }, { printPhotoKeys: null },
    { removePrintPhotoIds: null }, { removePrintPhotoIds: [1, -2] }, { removePrintPhotoIds: ['1'] },
  ]) {
    assert.ok((await validate(Object.assign(new UpdateOrderDto(), payload))).length > 0);
  }
  assert.equal((await validate(Object.assign(new UpdateOrderDto(), {
    finalSketchMessageId: null, printPhotoKeys: ['one.jpg', 'two.jpg'], removePrintPhotoIds: [1, 2],
  }))).length, 0);
});
