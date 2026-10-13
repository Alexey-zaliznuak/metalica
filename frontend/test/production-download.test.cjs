const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const ts = require('typescript')
const { AxiosError } = require('axios')
const jsxRuntime = require('react/jsx-runtime')

const source = fs.readFileSync(path.join(__dirname, '../src/components/ProductionDownloadButton.tsx'), 'utf8')
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.ReactJSX } }).outputText
const response = (status) => ({ data: { status, message: status === 'failed' ? 'Не удалось обработать' : null, expedited: false } })
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done }); return { promise, resolve } }

// A minimal effect-capable hook host drives the real component and its network/timer
// callbacks. MUI is stubbed because these tests check interactions, not rendering.
function mount({ statuses = ['pending'], post = async () => response('processing'), blob } = {}) {
  const hooks = []
  let cursor = 0, dirty = true, tree, effects = [], timerId = 0, mounted = true
  let props = { orderId: 7, attachmentId: 19, textSize: '40x60' }
  const requests = [], downloads = [], timers = new Map()
  const changed = (before, after) => !before || !after || before.length !== after.length || before.some((value, index) => !Object.is(value, after[index]))
  const react = {
    useState(initial) {
      const index = cursor++
      if (!hooks[index]) hooks[index] = { value: initial }
      return [hooks[index].value, (update) => {
        if (!mounted) return
        const value = typeof update === 'function' ? update(hooks[index].value) : update
        if (!Object.is(value, hooks[index].value)) { hooks[index].value = value; dirty = true }
      }]
    },
    useRef(initial) { const index = cursor++; return hooks[index] ?? (hooks[index] = { current: initial }) },
    useCallback(callback, deps) {
      const index = cursor++
      if (!hooks[index] || changed(hooks[index].deps, deps)) hooks[index] = { value: callback, deps }
      return hooks[index].value
    },
    useEffect(callback, deps) {
      const index = cursor++
      if (!hooks[index] || changed(hooks[index].deps, deps)) {
        const previous = hooks[index]
        const next = { deps, cleanup: null }
        hooks[index] = next
        effects.push(() => { previous?.cleanup?.(); next.cleanup = callback() })
      }
    },
  }
  let lastStatus = statuses[0]
  const client = {
    async get(url, options) {
      requests.push({ method: 'get', url, options })
      if (url.endsWith('/status')) {
        if (statuses.length) lastStatus = statuses.shift()
        return typeof lastStatus === 'string' ? response(lastStatus) : await lastStatus
      }
      return blob ? await (typeof blob === 'function' ? blob(url, options) : blob) : { data: new Blob(['image']), headers: { 'content-disposition': 'attachment; filename="selected-production.png"' } }
    },
    async post(url, body, options) { requests.push({ method: 'post', url, body, options }); return await post(url, options) },
  }
  const exports = {}
  const sandbox = {
    exports, module: { exports }, Blob,
    URL: { createObjectURL: () => 'blob:production', revokeObjectURL() {} },
    document: {
      createElement: () => { const link = { click() { downloads.push({ href: link.href, filename: link.download }) }, remove() {} }; return link },
      body: { appendChild() {} },
    },
    window: {
      setTimeout(callback, delay) { const id = ++timerId; timers.set(id, { callback, delay }); return id },
      clearTimeout(id) { timers.delete(id) },
    },
    require(name) {
      if (name === 'react') return react
      if (name === 'react/jsx-runtime') return jsxRuntime
      if (name === '@mui/material') return { Alert: 'Alert', Box: 'Box', Button: 'Button', CircularProgress: 'CircularProgress' }
      if (name === '@mui/icons-material/Download') return { default: 'DownloadIcon' }
      if (name === 'axios') return { AxiosError }
      if (name === '../api/client') return { default: client }
      if (name === '../api/errors') return { describeApiError: (error, fallback) => error.message || fallback }
      if (name === './AttachmentCard') return { attachmentActionSx: {} }
      throw new Error(`Unexpected import ${name}`)
    },
  }
  vm.runInNewContext(compiled, sandbox, { filename: 'ProductionDownloadButton.js' })
  const render = () => { cursor = 0; dirty = false; tree = exports.default(props) }
  const settle = async () => {
    for (let index = 0; index < 40; index++) {
      await Promise.resolve()
      if (dirty) render()
      const callbacks = effects; effects = []
      callbacks.forEach((callback) => callback())
      await Promise.resolve()
      if (index % 10 === 9) await new Promise(setImmediate)
    }
  }
  const nodes = (type, node = tree) => {
    if (!node || typeof node !== 'object') return []
    if (Array.isArray(node)) return node.flatMap((child) => nodes(type, child))
    return [...(node.type === type ? [node] : []), ...nodes(type, node.props?.children)]
  }
  const buttons = () => nodes('Button')
  const urgent = () => buttons().find((button) => button.props.children === 'Скачать досрочно')
  render()
  return {
    settle, urgent, buttons, requests, downloads, timers,
    unmount() { mounted = false; hooks.forEach((hook) => hook?.cleanup?.()); effects = [] },
    async clickUrgent() { const button = urgent(); assert.ok(button, 'Urgent action is available'); button.props.onClick(); await settle() },
    async setSize(textSize) { props = { ...props, textSize }; dirty = true; await settle() },
    async poll() {
      const timer = [...timers].find(([, value]) => value.delay === 4000)
      assert.ok(timer, 'A status poll is scheduled')
      timers.delete(timer[0]); await timer[1].callback(); await settle()
    },
    alerts: () => nodes('Alert').map((alert) => alert.props.children),
  }
}

test('urgent download appears only while production is pending or processing', async () => {
  for (const status of ['pending', 'processing', 'ready', 'failed']) {
    const view = mount({ statuses: [status] })
    await view.settle()
    assert.equal(Boolean(view.urgent()), status === 'pending' || status === 'processing', status)
  }
  const waiting = deferred()
  const view = mount({ statuses: [waiting.promise] })
  await view.settle()
  assert.equal(view.urgent(), undefined, 'Unknown status has no urgent action')
})

test('urgent request uses the selected size and polling downloads the ready file exactly once', async () => {
  const view = mount({ statuses: ['pending', 'processing', 'ready'] })
  await view.settle()
  await view.clickUrgent()
  const request = view.requests.find((row) => row.method === 'post')
  assert.equal(request.url, '/orders/7/attachments/19/production/expedite')
  assert.equal(request.options.params.textSize, '40x60')
  assert.equal(view.downloads.length, 0)
  await view.poll()
  await view.settle()
  assert.equal(view.downloads.length, 1)
  assert.equal(view.downloads[0].filename, 'selected-production.png')
  const files = view.requests.filter((row) => row.options?.responseType === 'blob')
  assert.equal(files.length, 1)
  assert.equal(files[0].options.params.textSize, '40x60')
  assert.equal(view.urgent(), undefined)
  assert.equal([...view.timers.values()].filter((timer) => timer.delay === 4000).length, 0)
})

test('pending jobs continue status polling without downloading', async () => {
  const view = mount({ statuses: ['pending', 'pending', 'processing'] })
  await view.settle()
  await view.poll()
  await view.poll()
  assert.equal(view.downloads.length, 0)
  assert.equal(view.requests.filter((row) => row.url.endsWith('/status')).length, 3)
  assert.ok([...view.timers.values()].some((timer) => timer.delay === 4000))
})

test('changing size cancels an armed automatic download for the previous size', async () => {
  const view = mount({ statuses: ['pending', 'processing', 'ready'] })
  await view.settle()
  await view.clickUrgent()
  await view.setSize('60x80')
  assert.equal(view.downloads.length, 0)
  assert.equal(view.requests.filter((row) => row.options?.responseType === 'blob').length, 0)
  assert.equal(view.requests.at(-1).options.params.textSize, '60x80')
})

test('changing size while the previous file downloads prevents saving the old file', async () => {
  const file = deferred()
  const view = mount({ statuses: ['pending', 'ready', 'ready'], blob: file.promise })
  await view.settle()
  await view.clickUrgent()
  assert.equal(view.requests.filter((row) => row.options?.responseType === 'blob').length, 1)
  await view.setSize('30x40')
  file.resolve({ data: new Blob(['old image']), headers: {} })
  await view.settle()
  assert.equal(view.downloads.length, 0)
})

test('failed production cancels the automatic download and shows its error', async () => {
  const view = mount({ statuses: ['pending', 'failed'] })
  await view.settle()
  await view.clickUrgent()
  assert.equal(view.downloads.length, 0)
  assert.equal(view.urgent(), undefined)
  assert.ok(view.alerts().includes('Не удалось обработать'))
})

test('a failed urgent POST clears automatic download even if the file later becomes ready', async () => {
  const view = mount({ statuses: ['pending', 'ready'], post: async () => { throw new AxiosError('Нет доступа') } })
  await view.settle()
  await view.clickUrgent()
  assert.ok(view.alerts().includes('Нет доступа'))
  await view.poll()
  assert.equal(view.downloads.length, 0)
  assert.equal(view.requests.filter((row) => row.options?.responseType === 'blob').length, 0)
})

test('rapid repeated urgent clicks send only one request', async () => {
  const pending = deferred()
  const view = mount({ statuses: ['pending', 'processing'], post: () => pending.promise })
  await view.settle()
  const button = view.urgent()
  button.props.onClick()
  button.props.onClick()
  assert.equal(view.requests.filter((row) => row.method === 'post').length, 1)
  pending.resolve(response('processing'))
  await view.settle()
})

test('unmounting during automatic file fetch prevents a later download', async () => {
  const file = deferred()
  const view = mount({ statuses: ['pending', 'ready'], blob: file.promise })
  await view.settle()
  await view.clickUrgent()
  assert.equal(view.requests.filter((row) => row.options?.responseType === 'blob').length, 1)
  view.unmount()
  file.resolve({ data: new Blob(['image']), headers: {} })
  await view.settle()
  assert.equal(view.downloads.length, 0)
  assert.equal([...view.timers.values()].filter((timer) => timer.delay === 4000).length, 0)
})

test('a file invalidated after readiness resumes polling and auto-downloads the updated file once', async () => {
  let attempts = 0
  const view = mount({
    statuses: ['pending', 'ready', 'processing', 'ready'],
    blob: async () => {
      attempts++
      if (attempts === 1) throw new AxiosError('Файл изменился', undefined, undefined, undefined, { status: 409, data: new Blob([JSON.stringify({ message: 'Готовится новая версия' })]) })
      return { data: new Blob(['new image']), headers: { 'content-disposition': 'attachment; filename="new-version.png"' } }
    },
  })
  await view.settle()
  await view.clickUrgent()
  assert.equal(attempts, 1)
  assert.equal(view.downloads.length, 0)
  await view.poll()
  assert.equal(attempts, 2)
  assert.equal(view.downloads.length, 1)
  assert.equal(view.downloads[0].filename, 'new-version.png')
  await view.settle()
  assert.equal(attempts, 2)
})

test('an old-size error decoded after switching sizes cannot alter the new-size state', async () => {
  const decoded = deferred()
  class SlowErrorBlob extends Blob { text() { return decoded.promise } }
  const view = mount({
    statuses: ['pending', 'ready', 'ready'],
    blob: async () => { throw new AxiosError('Старая версия изменена', undefined, undefined, undefined, { status: 409, data: new SlowErrorBlob() }) },
  })
  await view.settle()
  await view.clickUrgent()
  await view.setSize('60x80')
  assert.equal(view.alerts().length, 0)
  decoded.resolve(JSON.stringify({ message: 'Старый размер ещё готовится' }))
  await view.settle()
  assert.equal(view.downloads.length, 0)
  assert.equal(view.alerts().length, 0, 'Old error does not leave a readiness notice for the new size')
})
