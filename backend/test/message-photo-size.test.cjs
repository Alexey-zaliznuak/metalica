// Run after npm run build: node --test test/message-photo-size.test.cjs
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { validate } = require('class-validator');
const { MessagesService } = require('../dist/messages/messages.service');
const { MessagesController } = require('../dist/messages/messages.controller');
const { OrdersService } = require('../dist/orders/orders.service');
const { OrdersController } = require('../dist/orders/orders.controller');
const { AttachmentsService } = require('../dist/storage/attachments.service');
const { UpdateAttachmentPhotoSizeDto } = require('../dist/storage/dto/update-attachment-photo-size.dto');

function setup() {
  const attachment = { id: 9, messageId: 7, objectKey: 'original.jpg', filename: 'photo.jpg', mimeType: 'image/jpeg',
    size: 123456, photoSize: null, previewStatus: 'ready', thumbnailKey: 'thumb.webp', previewKey: 'preview.webp', kind: 'attachment' };
  const writes = [];
  const prisma = {
    order: { findUnique: async ({ where }) => where.id === 10 ? { id: 10 } : null },
    attachment: {
      findFirst: async ({ where }) => where.id === attachment.id && where.messageId === attachment.messageId && where.message.orderId === 10 ? { ...attachment } : null,
      update: async ({ where, data }) => { assert.equal(where.id, attachment.id); writes.push(data); Object.assign(attachment, data); return { ...attachment }; },
    },
    message: { findMany: async () => [{ id: 7, orderId: 10, body: 'Эскиз', createdAt: new Date(),
      author: { id: 3, name: 'Художник', role: 'SKETCH_DESIGNER' }, attachments: [{ ...attachment }], revision: null, revisionClosure: null }] },
  };
  const attachments = new AttachmentsService(prisma, { getUrl: async (key) => `/files/${key}` });
  return { attachment, writes, service: new MessagesService(prisma, attachments) };
}

test('all three photo sizes persist per attachment and survive loading messages again', async () => {
  const { service, attachment, writes } = setup();
  for (const photoSize of ['30x40', '40x60', '60x80']) {
    const response = await service.updateAttachmentPhotoSize(10, 7, 9, { photoSize });
    assert.equal(response.id, 9);
    assert.equal(response.photoSize, photoSize);
    assert.equal(response.size, 123456);
    assert.equal(response.url, '/files/original.jpg');
    assert.equal(response.thumbnailUrl, '/files/thumb.webp');
    const page = await service.list(10);
    assert.equal(page.items[0].attachments[0].photoSize, photoSize);
    assert.equal(attachment.objectKey, 'original.jpg');
  }
  assert.deepEqual(writes, [{ photoSize: '30x40' }, { photoSize: '40x60' }, { photoSize: '60x80' }]);
});

test('old photos expose a null photo size until a size is selected', async () => {
  const { service } = setup();
  assert.equal((await service.list(10)).items[0].attachments[0].photoSize, null);
});

test('another order, another message and missing attachment cannot be modified', async () => {
  const { service, writes } = setup();
  for (const ids of [[99, 7, 9], [10, 99, 9], [10, 7, 99]]) {
    await assert.rejects(service.updateAttachmentPhotoSize(...ids, { photoSize: '40x60' }), { status: 404 });
  }
  assert.equal(writes.length, 0);
});

test('invalid sizes and non-photo formats are rejected without writes', async () => {
  const { service, attachment, writes } = setup();
  for (const photoSize of ['', '20x30', '40 х 60', null, undefined, 40]) {
    await assert.rejects(service.updateAttachmentPhotoSize(10, 7, 9, { photoSize }), { status: 400 });
  }
  for (const [filename, mimeType] of [['a.pdf', 'application/pdf'], ['a.DNG', 'image/dng'], ['a.svg', 'image/svg+xml'], ['a.txt', 'text/plain']]) {
    Object.assign(attachment, { filename, mimeType });
    await assert.rejects(service.updateAttachmentPhotoSize(10, 7, 9, { photoSize: '40x60' }), { status: 400 });
  }
  assert.equal(writes.length, 0);
});

test('request DTO accepts only the three canonical sizes and requires a value', async () => {
  for (const photoSize of ['30x40', '40x60', '60x80']) {
    assert.equal((await validate(Object.assign(new UpdateAttachmentPhotoSizeDto(), { photoSize }))).length, 0);
  }
  for (const photoSize of ['90x120', '40 × 60', '', null, undefined, []]) {
    assert.equal((await validate(Object.assign(new UpdateAttachmentPhotoSizeDto(), { photoSize }))).length, 1);
  }
});

test('controller preserves all identifiers when forwarding the update', async () => {
  const calls = [];
  const controller = new MessagesController({ updateAttachmentPhotoSize: async (...args) => { calls.push(args); return { photoSize: '40x60' }; } });
  assert.deepEqual(await controller.updateAttachmentPhotoSize(10, 7, 9, { photoSize: '40x60' }), { photoSize: '40x60' });
  assert.deepEqual(calls, [[10, 7, 9, { photoSize: '40x60' }]]);
});

function printPhotoSetup() {
  const photo = { id: 9, printPhotoOrderId: 10, messageId: null, objectKey: 'painting.jpg', filename: 'painting.jpg',
    mimeType: 'image/jpeg', size: 987654, photoSize: null, previewStatus: 'ready', kind: 'print-photo' };
  const writes = [];
  const prisma = { attachment: {
    findFirst: async ({ where }) => where.id === photo.id && where.printPhotoOrderId === photo.printPhotoOrderId ? { ...photo } : null,
    update: async ({ data }) => { writes.push(data); Object.assign(photo, data); return { ...photo }; },
  } };
  const attachments = new AttachmentsService(prisma, { getUrl: async (key) => `/files/${key}` });
  const service = new OrdersService(prisma, null, null, null, null, null, null, attachments, null, null);
  return { service, attachments, photo, writes };
}

test('production attachment saves all sizes and serialization retains them on subsequent reads', async () => {
  const { service, attachments, photo, writes } = printPhotoSetup();
  for (const photoSize of ['30x40', '40x60', '60x80']) {
    const result = await service.updatePrintPhotoSize(10, 9, { photoSize });
    assert.equal(result.photoSize, photoSize);
    assert.equal(result.size, 987654);
    assert.equal(result.url, '/files/painting.jpg');
    assert.equal((await attachments.serialize([{ ...photo }]))[0].photoSize, photoSize);
  }
  assert.deepEqual(writes, [{ photoSize: '30x40' }, { photoSize: '40x60' }, { photoSize: '60x80' }]);
});

test('production size update is confined to production photos of the specified order', async () => {
  const { service, photo, writes } = printPhotoSetup();
  await assert.rejects(service.updatePrintPhotoSize(99, 9, { photoSize: '40x60' }), { status: 404 });
  await assert.rejects(service.updatePrintPhotoSize(10, 99, { photoSize: '40x60' }), { status: 404 });
  photo.printPhotoOrderId = null;
  photo.messageId = 7;
  await assert.rejects(service.updatePrintPhotoSize(10, 9, { photoSize: '40x60' }), { status: 404 });
  assert.equal(writes.length, 0);
});

test('production size endpoint rejects unsupported sizes and file formats', async () => {
  const { service, photo, writes } = printPhotoSetup();
  await assert.rejects(service.updatePrintPhotoSize(10, 9, { photoSize: '10x20' }), { status: 400 });
  for (const filename of ['a.pdf', 'a.dng', 'a.svg']) {
    photo.filename = filename;
    await assert.rejects(service.updatePrintPhotoSize(10, 9, { photoSize: '40x60' }), { status: 400 });
  }
  assert.equal(writes.length, 0);
});

test('production controller forwards attachment and order ids with the size', async () => {
  const calls = [];
  const controller = new OrdersController({ updatePrintPhotoSize: async (...args) => { calls.push(args); return { photoSize: '60x80' }; } });
  assert.deepEqual(await controller.updatePrintPhotoSize(10, 9, { photoSize: '60x80' }), { photoSize: '60x80' });
  assert.deepEqual(calls, [[10, 9, { photoSize: '60x80' }]]);
});
