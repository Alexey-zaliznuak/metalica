// node --test test/image-previews.test.cjs
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const ts = require('typescript');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');

// Load the component for SSR without adding another frontend test runtime.
for (const extension of ['.ts', '.tsx']) {
  require.extensions[extension] = (module, filename) => {
    const { outputText } = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true }, fileName: filename,
    });
    module._compile(outputText, filename);
  };
}
const { default: ImageLightbox, ImageAttachmentPreview } = require('../src/components/ImageLightbox.tsx');
const image = {
  url: '/files/original-30mb.jpg', filename: 'photo.jpg', size: 30_000_000,
  thumbnailUrl: '/files/thumbnail.webp', previewUrl: '/files/preview.webp', previewStatus: 'ready',
};

test('lists render the thumbnail with lazy loading and do not load the original', () => {
  const markup = renderToStaticMarkup(React.createElement(ImageAttachmentPreview, { image, onOpen() {} }));
  assert.ok(markup.includes('src="/files/thumbnail.webp"'));
  assert.ok(markup.includes('loading="lazy"'));
  assert.ok(!markup.includes('src="/files/original-30mb.jpg"'));
});

test('opening an image renders the medium preview and offers the original explicitly', () => {
  const markup = renderToStaticMarkup(React.createElement(ImageLightbox, { image, onClose() {} }));
  assert.ok(markup.includes('src="/files/preview.webp"'));
  assert.ok(markup.includes('Открыть оригинал'));
  assert.ok(!markup.includes('src="/files/original-30mb.jpg"'));
});

test('missing previews show placeholders without implicitly loading a huge image', () => {
  for (const Component of [ImageAttachmentPreview, ImageLightbox]) {
    const markup = renderToStaticMarkup(React.createElement(Component, {
      image: { ...image, thumbnailUrl: null, previewUrl: null, previewStatus: 'pending' }, onOpen() {}, onClose() {},
    }));
    assert.ok(markup.includes('Превью готовится'));
    assert.ok(!markup.includes('<img'));
  }
});

test('HEIC attachments render the server thumbnail', () => {
  const markup = renderToStaticMarkup(React.createElement(ImageAttachmentPreview, {
    image: { ...image, filename: 'iphone.heic', url: '/files/iphone.heic' }, onOpen() {},
  }));
  assert.ok(markup.includes('src="/files/thumbnail.webp"'));
  assert.ok(!markup.includes('src="/files/iphone.heic"'));
});

test('selected photo size appears above file weight in thumbnail and lightbox', () => {
  for (const Component of [ImageAttachmentPreview, ImageLightbox]) {
    const markup = renderToStaticMarkup(React.createElement(Component, {
      image: { ...image, photoSize: '40x60', size: 1024 }, onOpen() {}, onClose() {},
    }));
    assert.ok(markup.includes('40 х 60'));
    assert.ok(markup.indexOf('40 х 60') < markup.indexOf('1.0 КБ'), 'Photo dimensions must be above file weight');
  }
});

test('photo size is visible even without file weight metadata', () => {
  const markup = renderToStaticMarkup(React.createElement(ImageAttachmentPreview, {
    image: { ...image, photoSize: '30x40', size: null }, onOpen() {},
  }));
  assert.ok(markup.includes('30 х 40'));
});

test('size selection is a third action only when provided by the order chat', () => {
  const ordinary = renderToStaticMarkup(React.createElement(ImageAttachmentPreview, { image, onOpen() {} }));
  assert.ok(!ordinary.includes('Установить размер'));
  const orderPhoto = renderToStaticMarkup(React.createElement(ImageAttachmentPreview, { image, onOpen() {}, onPhotoSizeChange: async () => {} }));
  assert.equal((orderPhoto.match(/<button\b/g) || []).length, 3);
  assert.ok(orderPhoto.indexOf('Копировать') < orderPhoto.indexOf('Установить размер'));
});
