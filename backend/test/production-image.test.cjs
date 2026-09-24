// Run after npm run build: node --test test/production-image.test.cjs
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { writeFile, access } = require('node:fs/promises');
const sharp = require('sharp');
const { productionImage, productionHeader, productionArticleText, isShownOnProductionImage, productionTextScale } = require('../dist/orders/production-image');
const { OrdersService } = require('../dist/orders/orders.service');

const article = (values) => ({ article: null, name: null, size: null, quantity: 1, comment: null, ...values });
const articles = [
  article({ article: 'Упаковка №3', size: '40×60' }),
  article({ article: 'Спрей' }),
  article({ article: 'Магнитное крепление' }),
  article({ article: 'Доп лицо', quantity: 7 }),
];
const rawPixels = (input) => sharp(input).removeAlpha().raw().toBuffer();

test('portrait photo keeps its pixels and DPI, with a header on the short top edge', async () => {
  const width = 500;
  const height = 800;
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

test('landscape photo gets a rotated header on the short left edge without changing photo pixels', async () => {
  const width = 800;
  const height = 500;
  const pixels = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const offset = (y * width + x) * 3;
    pixels[offset] = x % 256;
    pixels[offset + 1] = y % 256;
    pixels[offset + 2] = 70;
  }
  const input = await sharp(pixels, { raw: { width, height, channels: 3 } }).png().toBuffer();
  const result = await (await productionImage(input, '29538603', articles, null, 1, 'СДЭК / Самовывоз')).toBuffer();
  const meta = await sharp(result).metadata();
  const header = await productionHeader(height, '29538603', articles, null, 1, 'СДЭК / Самовывоз');
  assert.equal(meta.width, width + header.height);
  assert.equal(meta.height, height);
  assert.ok(meta.width * meta.height < width * (height + header.height));
  const photo = await sharp(result).extract({ left: header.height, top: 0, width, height }).removeAlpha().raw().toBuffer();
  assert.deepEqual(photo, await rawPixels(input));
  const actualHeader = await sharp(result).extract({ left: 0, top: 0, width: header.height, height }).removeAlpha().raw().toBuffer();
  const expectedHeader = await sharp(header.buffer).rotate(270).removeAlpha().raw().toBuffer();
  assert.deepEqual(actualHeader, expectedHeader);
});

test('EXIF orientation determines which edge gets the header', async () => {
  const input = await sharp({ create: { width: 240, height: 400, channels: 3, background: '#126a9e' } })
    .withMetadata({ orientation: 6 }).jpeg().toBuffer();
  const result = await (await productionImage(input, '1234567', [])).toBuffer();
  const metadata = await sharp(result).metadata();
  const header = await productionHeader(240, '1234567', []);
  assert.equal(metadata.width, 400 + header.height);
  assert.equal(metadata.height, 240);
  assert.equal(metadata.orientation, 1);
  const extracted = await sharp(result).extract({ left: header.height, top: 0, width: 400, height: 240 }).removeAlpha().raw().toBuffer();
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

test('prints the order comment above the mirrored number', async () => {
  const empty = await productionHeader(1000, '1234567', []);
  const blank = await productionHeader(1000, '1234567', [], '   ');
  assert.equal(blank.height, empty.height);
  const { buffer, height } = await productionHeader(1000, '1234567', [], 'Срочно, матовая');
  assert.ok(height > empty.height);
  const { data: normal, info } = await sharp({
    text: { text: 'Срочно, матовая', font: 'sans 18', width: 300, wrap: 'word-char', rgba: true, dpi: 72 },
  }).png().toBuffer({ resolveWithObject: true });
  const number = await sharp({ text: { text: '1234567', font: 'sans 45', rgba: true, dpi: 72 } }).png().metadata();
  const left = 65 + Math.floor((300 - info.width) / 2);
  const top = height - 20 - number.height - 8 - info.height;
  const comment = await sharp(buffer).extract({ left, top, width: info.width, height: info.height }).png().toBuffer();
  const expected = await sharp(normal).flop().flatten({ background: 'white' }).raw().toBuffer();
  const actual = await rawPixels(comment);
  assert.equal(actual.length, expected.length);
  assert.ok(actual.every((value, i) => Math.abs(value - expected[i]) <= 1), 'comment must sit above the mirrored number');
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
  assert.equal(productionArticleText(merged[1]), 'Упаковка · 30×40 · ×1');
  assert.equal(productionArticleText(merged[2]), 'Упаковка · 40×60 · ×1');
  assert.match(productionArticleText(merged[3]), /Особая обработка/);
  assert.equal(productionArticleText(article({ article: 'SKU-1', name: 'Модель А', size: '60×90', quantity: 2, comment: 'Упаковать отдельно' })), 'SKU-1 — Модель А · 60×90 · ×2 · Упаковать отдельно');
});

test('keeps service SKUs off production photos and prints size next to the article', () => {
  assert.equal(isShownOnProductionImage(article({ article: 'Работа художника в стиле Нейроарт' })), false);
  assert.equal(isShownOnProductionImage(article({ name: 'Работа художника в стиле Нейроарт' })), false);
  assert.equal(isShownOnProductionImage(article({ article: 'Картина на металле 40*60см' })), false);
  assert.equal(isShownOnProductionImage(article({ article: 'картина на металле' })), false);
  assert.equal(isShownOnProductionImage(article({ article: 'Упаковка №3', size: '40×60' })), true);
  assert.equal(productionArticleText(article({ article: 'Упаковка №3', size: '40×60' })), 'Упаковка №3 · 40×60 · ×1');
});

test('maps print sizes to overlay text scales', () => {
  assert.equal(productionTextScale('30x40'), 1);
  assert.equal(productionTextScale('standard'), 1);
  assert.equal(productionTextScale(), 1);
  assert.equal(productionTextScale('40x60'), 1 / 1.5);
  assert.equal(productionTextScale('60x80'), 1 / 2);
  assert.equal(productionTextScale('small'), 1 / 2);
});

test('small text size halves overlay fonts except the order number', async () => {
  const standard = await productionHeader(1000, '1234567', articles, 'Срочно, матовая');
  const small = await productionHeader(1000, '1234567', articles, 'Срочно, матовая', 0.5);
  const numberOnly = await productionHeader(1000, '1234567', []);
  assert.ok(small.height < standard.height);
  const { info } = await sharp({ text: { text: '1234567', font: 'sans 45', rgba: true, dpi: 72 } })
    .png().toBuffer({ resolveWithObject: true });
  const left = 65 + Math.floor((300 - info.width) / 2);
  const standardNumber = await sharp(standard.buffer).extract({
    left, top: standard.height - 20 - info.height, width: info.width, height: info.height,
  }).png().toBuffer();
  const smallNumber = await sharp(small.buffer).extract({
    left, top: small.height - 20 - info.height, width: info.width, height: info.height,
  }).png().toBuffer();
  const expected = await rawPixels(standardNumber);
  const actual = await rawPixels(smallNumber);
  assert.equal(actual.length, expected.length);
  assert.ok(actual.every((value, i) => Math.abs(value - expected[i]) <= 1), 'order number must stay the same size');
  assert.equal(numberOnly.height, (await productionHeader(1000, '1234567', [], null, 0.5)).height);
});

async function rightmostInk(buffer) {
  const { data, info } = await sharp(buffer).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  let maxX = 0;
  for (let y = 0; y < info.height; y++) {
    for (let x = info.width - 1; x >= 0; x--) {
      const offset = (y * info.width + x) * 3;
      if (data[offset] < 250 || data[offset + 1] < 250 || data[offset + 2] < 250) {
        if (x > maxX) maxX = x;
        break;
      }
    }
  }
  return maxX;
}

test('keeps article text against the right edge in both text sizes', async () => {
  const standard = await productionHeader(1000, '1234567', articles);
  const small = await productionHeader(1000, '1234567', articles, null, 0.5);
  const standardRight = await rightmostInk(standard.buffer);
  const smallRight = await rightmostInk(small.buffer);
  assert.ok(standardRight > 900, 'standard articles must sit on the right edge');
  assert.ok(Math.abs(standardRight - smallRight) <= 8, 'small articles must keep the same right edge');
});

test('prints long delivery service horizontally above the number without changing its photo gap', async () => {
  const empty = await productionHeader(1000, '1234567', []);
  const label = 'Очень длинное название службы доставки и способа получения заказа клиентом';
  const withService = await productionHeader(1000, '1234567', [], 'Матовая', 1, label);
  const delivery = await sharp({ text: {
    text: label, font: 'sans 14', width: 300, wrap: 'word-char', rgba: true, dpi: 72,
  } }).flop().png().toBuffer({ resolveWithObject: true });
  const number = await sharp({ text: { text: '1234567', font: 'sans 45', rgba: true, dpi: 72 } })
    .png().toBuffer({ resolveWithObject: true });
  const numberTop = withService.height - 20 - number.info.height;
  const deliveryTop = numberTop - 8 - delivery.info.height;
  const deliveryLeft = 65 + Math.floor((300 - delivery.info.width) / 2);
  const actual = await sharp(withService.buffer).extract({
    left: deliveryLeft, top: deliveryTop, width: delivery.info.width, height: delivery.info.height,
  }).removeAlpha().raw().toBuffer();
  const expected = await sharp(delivery.data).flatten({ background: 'white' }).raw().toBuffer();
  assert.ok(actual.every((value, i) => Math.abs(value - expected[i]) <= 1));
  assert.ok(delivery.info.width <= 300);
  assert.ok(withService.height < 500, 'a long service should wrap instead of making a tall vertical strip');
  const baseNumber = await sharp(empty.buffer).extract({
    left: 65 + Math.floor((300 - number.info.width) / 2),
    top: empty.height - 20 - number.info.height,
    width: number.info.width, height: number.info.height,
  }).removeAlpha().raw().toBuffer();
  const labeledNumber = await sharp(withService.buffer).extract({
    left: 65 + Math.floor((300 - number.info.width) / 2), top: numberTop,
    width: number.info.width, height: number.info.height,
  }).removeAlpha().raw().toBuffer();
  assert.ok(labeledNumber.every((value, i) => Math.abs(value - baseNumber[i]) <= 1));
});

test('rejects corrupt and vector files instead of returning an unprocessed original', async () => {
  await assert.rejects(productionImage(Buffer.from('broken image'), '123', []));
  await assert.rejects(productionImage(Buffer.from('<svg width="400" height="400"><rect width="400" height="400"/></svg>'), '123', []), /растровое/);
});

function setupDownload({ pinnedMessageId = 25, found = true, storageError = false } = {}) {
  let lookup;
  let sourcePath;
  let readCount = 0;
  const service = new OrdersService({
    order: { findUnique: async () => ({
      orderNumber: '29538603',
      pinnedSketches: pinnedMessageId == null ? [] : [{ messageId: pinnedMessageId }],
      bluesalesInfo: null,
    }) },
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

test('download is scoped to this order’s print photos or its pinned sketches', async () => {
  const state = setupDownload({ found: false });
  await assert.rejects(state.service.downloadProductionImage(10, 999), /этого заказа/);
  assert.deepEqual(state.lookup().where, { id: 999, OR: [
    { printPhotoOrderId: 10 }, { message: { id: 25, orderId: 10 } },
  ] });
  assert.equal(state.readCount(), 0);
  const unmarked = setupDownload({ found: false, pinnedMessageId: null });
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
