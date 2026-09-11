// Run after npm run build: node --test test/production-image.test.cjs
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { writeFile, access } = require('node:fs/promises');
const sharp = require('sharp');
const { productionImage, productionHeader, productionArticleText } = require('../dist/orders/production-image');
const { OrdersService } = require('../dist/orders/orders.service');

const article = (values) => ({ article: null, name: null, size: null, quantity: 1, comment: null, ...values });
const articles = [
  article({ article: 'Упаковка №3', size: '40×60' }),
  article({ article: 'Спрей' }),
  article({ article: 'Магнитное крепление' }),
  article({ article: 'Доп лицо', quantity: 7 }),
];
const rawPixels = (input) => sharp(input).removeAlpha().raw().toBuffer();

test('adds a white header without resizing, mirroring or changing photo pixels; preserves DPI', async () => {
  const width = 800;
  const height = 500;
  const pixels = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const offset = (y * width + x) * 3;
    pixels[offset] = x % 256;
    pixels[offset + 1] = y % 256;
    pixels[offset + 2] = 70;
  }
  const input = await sharp(pixels, { raw: { width, height, channels: 3 } }).withMetadata({ density: 300 }).png().toBuffer();
  const result = await (await productionImage(input, '29538603', articles)).toBuffer();
  const meta = await sharp(result).metadata();
  assert.equal(meta.width, width);
  assert.ok(meta.height > height);
  assert.equal(meta.density, 300);
  const photo = await sharp(result).extract({ left: 0, top: meta.height - height, width, height }).removeAlpha().raw().toBuffer();
  assert.deepEqual(photo, await rawPixels(input));
  const corner = await sharp(result).extract({ left: 0, top: 0, width: 8, height: 8 }).removeAlpha().raw().toBuffer();
  assert.ok(corner.every((value) => value === 255));
});

test('honours EXIF orientation before adding the header', async () => {
  const input = await sharp({ create: { width: 240, height: 400, channels: 3, background: '#126a9e' } })
    .withMetadata({ orientation: 6 }).jpeg().toBuffer();
  const result = await (await productionImage(input, '1234567', [])).toBuffer();
  const metadata = await sharp(result).metadata();
  assert.equal(metadata.width, 400);
  assert.equal(metadata.orientation, 1);
  const extracted = await sharp(result).extract({ left: 0, top: metadata.height - 240, width: 400, height: 240 }).removeAlpha().raw().toBuffer();
  assert.deepEqual(extracted, await sharp(input).rotate().removeAlpha().raw().toBuffer());
});

test('number is mirrored within the left column, with downward arrows on both sides', async () => {
  const { buffer, height } = await productionHeader(1000, '1234567', []);
  const { data: normal, info } = await sharp({ text: { text: '1234567', font: 'sans 45', rgba: true, dpi: 72 } })
    .png().toBuffer({ resolveWithObject: true });
  const left = 65 + Math.floor((300 - info.width) / 2);
  const number = await sharp(buffer).extract({ left, top: height - 20 - info.height, width: info.width, height: info.height }).png().toBuffer();
  const expected = await sharp(normal).flop().flatten({ background: 'white' }).raw().toBuffer();
  const actual = await rawPixels(number);
  // Compositing and flattening can round antialiased edge pixels differently by 1/255.
  assert.equal(actual.length, expected.length);
  assert.ok(actual.every((value, i) => Math.abs(value - expected[i]) <= 1), 'number must match the mirrored glyphs');
  assert.ok(!actual.equals(await sharp(normal).flatten({ background: 'white' }).raw().toBuffer()));
  for (const x of [35, 395]) {
    const arrow = await sharp(buffer).extract({ left: x - 6, top: height - 41, width: 13, height: 36 }).removeAlpha().raw().toBuffer();
    assert.ok(arrow.some((value) => value < 30));
  }
});

test('header scales with width and expands for long article lists without shrinking the photo', async () => {
  const small = await productionHeader(400, '1234567', articles);
  const large = await productionHeader(1600, '1234567', articles);
  // Wrapped lists may gain a line at smaller sizes due to font hinting and integer pixels.
  assert.ok(Math.abs(large.height / small.height - 4) < 0.5);
  const smallNumber = await productionHeader(400, '1234567', []);
  const largeNumber = await productionHeader(1600, '1234567', []);
  assert.ok(Math.abs(largeNumber.height / smallNumber.height - 4) < 0.1);
  const long = await productionHeader(400, '1234567', Array.from({ length: 20 }, (_, i) => article({ article: `Артикул ${i}`, name: 'Длинное название модели с переносом строк', size: '40×60' })));
  assert.ok(long.height > small.height * 3);
  await productionHeader(64, 'VERY-LONG-ORDER-NUMBER-123456789', articles);
  await productionHeader(400, '12<&3', [article({ article: 'Модель <b> & "размер"' })]);
});

test('uses the same grouping as the order page, preserving distinct sizes and comments', () => {
  const service = new OrdersService();
  const merged = service.extractArticles({ goodsPositions: [
    ...Array.from({ length: 7 }, () => ({ goods: { marking: 'доп лицо', name: 'доп лицо' }, quantity: 1 })),
    { goods: { marking: 'Упаковка' }, size: '30×40', quantity: 1 },
    { goods: { marking: 'Упаковка' }, size: '40×60', quantity: 1 },
    { goods: { marking: 'доп лицо' }, comment: 'Особая обработка', quantity: 1 },
  ] });
  assert.equal(merged.length, 4);
  assert.equal(productionArticleText(merged[0]), 'доп лицо · ×7');
  assert.equal(productionArticleText(merged[1]), 'Упаковка · ×1');
  assert.equal(productionArticleText(merged[2]), 'Упаковка · ×1');
  assert.match(productionArticleText(merged[3]), /Особая обработка/);
  assert.equal(productionArticleText(article({ article: 'SKU-1', name: 'Модель А', size: '60×90', quantity: 2, comment: 'Упаковать отдельно' })), 'SKU-1 — Модель А · ×2 · Упаковать отдельно');
});

test('rejects corrupt and vector files instead of returning an unprocessed original', async () => {
  await assert.rejects(productionImage(Buffer.from('broken image'), '123', []));
  await assert.rejects(productionImage(Buffer.from('<svg width="400" height="400"><rect width="400" height="400"/></svg>'), '123', []), /растровое/);
});

function setupDownload({ finalSketchMessageId = 25, found = true, storageError = false } = {}) {
  let lookup;
  let sourcePath;
  let readCount = 0;
  const service = new OrdersService({
    order: { findUnique: async () => ({ orderNumber: '29538603', finalSketchMessageId, bluesalesInfo: null }) },
    attachment: { findFirst: async (input) => {
      lookup = input;
      return found ? { id: 7, objectKey: 'original.png', filename: 'original.png', mimeType: 'image/png' } : null;
    } },
  }, null, null, null, {
    downloadToFile: async (key, destination) => {
      readCount++;
      sourcePath = destination;
      assert.equal(key, 'original.png');
      if (storageError) throw new Error('offline');
      await writeFile(destination, await sharp({ create: { width: 400, height: 600, channels: 3, background: 'blue' } }).png().toBuffer());
    },
  });
  return { service, lookup: () => lookup, sourcePath: () => sourcePath, readCount: () => readCount };
}

test('download is scoped to this order’s print photos or its current final sketch', async () => {
  const state = setupDownload({ found: false });
  await assert.rejects(state.service.downloadProductionImage(10, 999), /этого заказа/);
  assert.deepEqual(state.lookup().where, { id: 999, OR: [
    { printPhotoOrderId: 10 }, { message: { id: 25, orderId: 10 } },
  ] });
  assert.equal(state.readCount(), 0);
  const unmarked = setupDownload({ found: false, finalSketchMessageId: null });
  await assert.rejects(unmarked.service.downloadProductionImage(10, 999));
  assert.deepEqual(unmarked.lookup().where.OR, [{ printPhotoOrderId: 10 }]);
});

test('returns a named PNG attachment and removes temporary originals after download', async () => {
  const state = setupDownload();
  const file = await state.service.downloadProductionImage(10, 7);
  assert.equal(file.getHeaders().type, 'image/png');
  assert.equal(file.getHeaders().disposition, 'attachment; filename="production-29538603-7.png"');
  const chunks = [];
  for await (const chunk of file.getStream()) chunks.push(chunk);
  const result = Buffer.concat(chunks);
  assert.equal(result.length, file.getHeaders().length);
  assert.equal((await sharp(result).metadata()).width, 400);
  for (let attempt = 0; attempt < 30; attempt++) {
    try { await access(state.sourcePath()); } catch { return; }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail('temporary original was not removed');
});

test('storage failure is actionable and cleans up its temporary directory', async () => {
  const state = setupDownload({ storageError: true });
  await assert.rejects(state.service.downloadProductionImage(10, 7), /хранилища/);
  await assert.rejects(access(require('node:path').dirname(state.sourcePath())));
});
