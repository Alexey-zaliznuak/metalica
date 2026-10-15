const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const jsx = require('react/jsx-runtime');

const source = fs.readFileSync(path.join(__dirname, '../src/components/PhotoSizeSelector.tsx'), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.ReactJSX } }).outputText;

function mount(onChange, value = null) {
  const hooks = [];
  let cursor = 0, tree;
  const exports = {};
  vm.runInNewContext(compiled, { exports, require(name) {
    if (name === 'react') return {
      useState(initial) { const index = cursor++; hooks[index] ??= { value: initial }; return [hooks[index].value, (next) => { hooks[index].value = next; }]; },
      useRef(initial) { const index = cursor++; return hooks[index] ??= { current: initial }; },
    };
    if (name === 'react/jsx-runtime') return jsx;
    if (name === '@mui/material') return { Box: 'Box', Button: 'Button', CircularProgress: 'Progress', Typography: 'Text' };
    if (name === '../api/errors') return { describeApiError: (error, fallback) => error.message || fallback };
    if (name === './AttachmentCard') return { attachmentActionSx: {} };
    throw new Error(`Unexpected import: ${name}`);
  } });
  const render = () => { cursor = 0; tree = exports.default({ onChange, value }); };
  const nodes = (type, node = tree) => !node || typeof node !== 'object' ? [] : Array.isArray(node)
    ? node.flatMap((child) => nodes(type, child))
    : [...(node.type === type ? [node] : []), ...nodes(type, node.props?.children)];
  const settle = async () => { for (let i = 0; i < 10; i++) { await Promise.resolve(); render(); } };
  render();
  return { settle, buttons: () => nodes('Button'), alerts: () => nodes('Text').filter((node) => node.props.role === 'alert'),
    async click(index) { nodes('Button')[index].props.onClick(); await settle(); } };
}

test('one size action expands into exactly three choices and marks the stored size', async () => {
  const view = mount(async () => {}, '40x60');
  assert.deepEqual(view.buttons().map((button) => button.props.children), ['Установить размер']);
  await view.click(0);
  assert.deepEqual(view.buttons().map((button) => button.props.children), ['30 х 40', '40 х 60', '60 х 80']);
  assert.deepEqual(view.buttons().map((button) => button.props['aria-pressed']), [false, true, false]);
});

test('selected canonical size is saved once, choices lock while saving, then collapse', async () => {
  const saved = [];
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const view = mount(async (size) => { saved.push(size); await gate; });
  await view.click(0);
  const button = view.buttons()[2];
  button.props.onClick();
  button.props.onClick();
  await view.settle();
  assert.deepEqual(saved, ['60x80']);
  assert.ok(view.buttons().every((choice) => choice.props.disabled));
  release();
  await view.settle();
  assert.equal(view.buttons().length, 1);
  assert.equal(view.buttons()[0].props.children, 'Установить размер');
});

test('failed save stays open, shows the error and allows another size to be saved', async () => {
  const saved = [];
  const view = mount(async (size) => { saved.push(size); if (saved.length === 1) throw new Error('Сервер недоступен'); });
  await view.click(0);
  await view.click(1);
  assert.equal(view.buttons().length, 3);
  assert.ok(view.buttons().every((choice) => !choice.props.disabled));
  assert.equal(view.alerts()[0].props.children, 'Сервер недоступен');
  await view.click(0);
  assert.deepEqual(saved, ['40x60', '30x40']);
  assert.equal(view.alerts().length, 0);
  assert.equal(view.buttons().length, 1);
});
