// No live API calls: exercise the real queued HTTP client with fake responses.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { BluesalesApiService, BluesalesInvalidResponseError, BluesalesRejectedError } = require('../dist/bluesales/bluesales-api.service');

function setup() {
  const logs = [], successes = [];
  const config = { get: (key, fallback) => ({ BLUESALES_LOGIN: 'fake-login', BLUESALES_PASSWORD: 'fake-password' })[key] ?? fallback };
  const api = new BluesalesApiService(config, { recordSuccess: async r => successes.push(r) }, { enabled: true });
  api.waitForRequestGap = async () => {};
  api.logger = { log() {}, warn() {}, error: message => logs.push(message) };
  return { api, logs, successes };
}

test('HTML with HTTP 200 retains the error after a long head and hides authenticated URLs', async t => {
  const { api, logs, successes } = setup();
  const html = `\r\n<!DOCTYPE html><html><head><title>Ошибка BlueSales</title>
    <style>${'x'.repeat(9000)}</style><script>private-script</script></head><body>
    <input value="private-form-token"><h1>Ошибка &amp; детали</h1>
    <p>Missing required value &quot;exampleField&quot;.</p>
    <p>https://example.invalid/path?login=fake-login&amp;password=${api.passwordHash}&amp;key=private-key</p>
    <p>login: fake-login hash: ${api.passwordHash}</p>
    </body></html>`;
  const fetch = t.mock.method(global, 'fetch', async () => ({
    status: 200, redirected: true,
    url: `https://example.invalid/app/Error.aspx?aspxerrorpath=%2Fapp&login=fake-login&password=${api.passwordHash}`,
    headers: new Headers({ 'content-type': 'text/html; charset=utf-8' }), text: async () => html,
  }));
  await assert.rejects(api.send('customers.add', {}, { label: 'metavista' }), error => {
    assert.ok(error instanceof BluesalesInvalidResponseError);
    assert.ok(!(error instanceof BluesalesRejectedError));
    assert.match(error.message, /HTTP=200.*type=text\/html.*redirected=true.*path=\/app\/Error.aspx/);
    assert.match(error.message, /Missing required value "exampleField"/);
    assert.match(error.responseDetails.body, /Ошибка & детали/);
    assert.equal(error.responseDetails.bodyChars, html.length);
    const output = JSON.stringify(error.responseDetails) + error.message + logs.join();
    for (const secret of ['fake-login', api.passwordHash, 'private-key', 'private-form-token', 'private-script', 'aspxerrorpath']) {
      assert.ok(!output.includes(secret), secret);
    }
    assert.doesNotMatch(error.message + logs.join(), /[\r\n]/);
    return true;
  });
  assert.equal(fetch.mock.callCount(), 1, 'the durable export queue controls retries');
  assert.match(logs[0], /label=metavista/);
  assert.deepEqual(successes, []);
});

test('Windows-1251 HTML keeps Russian error text readable', async t => {
  const { api } = setup();
  const html = '<html><body>Ошибка сервера</body></html>';
  const bytes = Uint8Array.from([...html].map(char => char.charCodeAt(0) >= 0x410 ? char.charCodeAt(0) - 0x410 + 0xc0 : char.charCodeAt(0)));
  t.mock.method(global, 'fetch', async () => new Response(bytes, { status: 500, headers: { 'content-type': 'text/html; charset=windows-1251' } }));
  await assert.rejects(api.send('customers.add'), error => {
    assert.equal(error.responseDetails.body, 'Ошибка сервера');
    assert.match(error.message, /HTTP=500/);
    return true;
  });
});

test('empty and plain-text responses expose status, and long details survive the short message', async t => {
  const { api } = setup();
  const cases = [
    [204, null, '(empty body)'],
    [502, 'upstream\r\nconnection failed', 'upstream connection failed'],
    [200, `<html><body>${'navigation '.repeat(200)}Actual error at the end</body></html>`, 'Actual error at the end'],
  ];
  for (const [status, body, expected] of cases) {
    t.mock.method(global, 'fetch', async () => new Response(body, { status }));
    await assert.rejects(api.send('customers.add'), error => {
      assert.equal(error.responseDetails.status, status);
      assert.ok(error.responseDetails.body.includes(expected));
      assert.ok(error.message.length < 1000);
      return true;
    });
  }
});

test('valid JSON retains normal success and rejection behavior', async t => {
  const { api, successes } = setup();
  const responses = [{ id: 123 }, { error: 'Explicit rejection' }];
  const fetch = t.mock.method(global, 'fetch', async () => Response.json(responses.shift()));
  assert.deepEqual(await api.send('customers.add', { fullName: 'Иван' }), { id: 123 });
  assert.equal(fetch.mock.calls[0].arguments[1].headers['Content-Type'], 'application/json; charset=utf-8');
  assert.deepEqual(JSON.parse(fetch.mock.calls[0].arguments[1].body), { fullName: 'Иван' });
  await assert.rejects(api.send('customers.add'), BluesalesRejectedError);
  assert.equal(successes.length, 1);
});
