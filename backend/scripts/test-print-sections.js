// Run after `npm run build`. No database or object storage is used.
const assert = require('node:assert/strict');
const { ProductionFilesService } = require('../dist/orders/production-files.service');

async function main() {
  let kind = 'print-inscription';
  let counts = 0;
  const db = {
    order: { findUnique: async () => ({ orderNumber: 'TEST-42', bluesalesInfo: { rawPayload: {
      goodsPositions: [{ goods: { marking: 'SKU', name: 'Product' }, count: 2 }],
      internalComments: 'PRIVATE COMMENT', deliveryService: 'CDEK',
    } } }) },
    attachment: {
      findFirst: async () => ({ kind, objectKey: 'test.png', filename: 'test.png', mimeType: 'image/png' }),
      count: async ({ where }) => {
        counts++;
        assert.equal(where.kind.not, 'print-inscription');
        return 2;
      },
    },
  };
  const service = new ProductionFilesService(db, {}, {});
  const inscription = await service.context(1, 10);
  assert.deepEqual(inscription.parameters, {
    orderNumber: 'TEST-42', numberOnly: true, photoNumber: null, articles: [], comment: null, deliveryService: null,
  });
  kind = 'print-photo';
  const photo = await service.context(1, 10);
  assert.equal(photo.parameters.photoNumber, 2);
  assert.equal(photo.parameters.articles[0].article, 'SKU');
  assert.equal(photo.parameters.comment, 'PRIVATE COMMENT');
  assert.ok(counts > 0);
  console.log('Print sections: number-only inscription and isolated photo numbering passed.');
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
