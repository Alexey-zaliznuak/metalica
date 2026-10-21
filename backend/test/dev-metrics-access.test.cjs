// Run after npm run build. Uses real HTTP, JWT validation, guards and user DTOs,
// with an in-memory user store; no external database or BlueSales requests.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Module, ValidationPipe } = require('@nestjs/common');
const { NestFactory } = require('@nestjs/core');
const { PassportModule } = require('@nestjs/passport');
const { JwtService } = require('@nestjs/jwt');
const { DevMetricsController } = require('../dist/bluesales/dev-metrics.controller');
const { BluesalesMetricsService } = require('../dist/bluesales/bluesales-metrics.service');
const { BluesalesInboundSyncService } = require('../dist/bluesales/bluesales-inbound-sync');
const { ImageQueueMetricsService } = require('../dist/storage/image-queue-metrics.service');
const { ProductionTaskMetricsService } = require('../dist/storage/production-task-metrics.service');
const { UsersController } = require('../dist/users/users.controller');
const { UsersService } = require('../dist/users/users.service');
const { JwtStrategy } = require('../dist/auth/jwt.strategy');
const { PrismaService } = require('../dist/prisma/prisma.service');

test('API metrics permission grants read access without granting admin actions', async (t) => {
  const users = new Map([
    [1, { id: 1, username: 'admin', role: 'ADMIN', scopes: [] }],
    [2, { id: 2, username: 'manager', role: 'MANAGER', scopes: [] }],
    [3, { id: 3, username: 'analyst', role: 'MANAGER', scopes: ['METRICS_VIEW', 'WORKLOAD_VIEW'] }],
  ]);
  const select = (row, fields) => fields ? Object.fromEntries(Object.keys(fields).map((key) => [key, row[key]])) : row;
  const prisma = { user: {
    findUnique: async ({ where }) => where.id ? users.get(where.id) : [...users.values()].find((user) => user.username === where.username),
    update: async ({ where, data, select: fields }) => {
      const user = { ...users.get(where.id), ...data };
      users.set(where.id, user);
      return select(user, fields);
    },
    create: async ({ data, select: fields }) => {
      const user = { id: users.size + 1, ...data };
      users.set(user.id, user);
      return select(user, fields);
    },
  } };
  let inboundEnabled = true;
  const settings = {
    getState: () => ({ enabled: inboundEnabled }),
    setEnabled: (enabled) => { inboundEnabled = enabled; return settings.getState(); },
  };
  class TestModule {}
  Module({
    imports: [PassportModule], controllers: [DevMetricsController, UsersController],
    providers: [JwtStrategy, UsersService,
      { provide: PrismaService, useValue: prisma },
      { provide: BluesalesMetricsService, useValue: { overview: () => ({ kind: 'api' }) } },
      { provide: ImageQueueMetricsService, useValue: { overview: () => ({ kind: 'images' }) } },
      { provide: ProductionTaskMetricsService, useValue: { overview: () => ({ kind: 'production' }) } },
      { provide: BluesalesInboundSyncService, useValue: settings },
    ],
  })(TestModule);
  const app = await NestFactory.create(TestModule, { logger: false, abortOnError: false });
  t.after(() => app.close());
  app.setGlobalPrefix('api');
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  await app.listen(0, '127.0.0.1');
  const baseUrl = await app.getUrl();
  const jwt = new JwtService({ secret: process.env.JWT_SECRET || 'dev-secret-change-me' });
  const tokenFor = (id, claims = {}) => jwt.sign({ sub: id, role: users.get(id)?.role, scopes: users.get(id)?.scopes, ...claims });
  const request = (path, token, method = 'GET', body) => fetch(`${baseUrl}/api${path}`, {
    method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const endpoints = ['/dev-metrics', '/dev-metrics/image-queue', '/dev-metrics/production-debug', '/dev-metrics/inbound-sync'];
  const adminToken = tokenFor(1);
  const managerToken = tokenFor(2);

  await t.test('authentication and the separate permission protect every metrics endpoint', async () => {
    for (const endpoint of endpoints) {
      assert.equal((await request(endpoint)).status, 401, endpoint);
      assert.equal((await request(endpoint, managerToken)).status, 403, endpoint);
      assert.equal((await request(endpoint, tokenFor(3))).status, 403, 'METRICS_VIEW is not API_METRICS_VIEW');
      assert.equal((await request(endpoint, adminToken)).status, 200, 'admin needs no explicit scopes');
    }
    assert.equal((await request('/dev-metrics/inbound-sync', undefined, 'PATCH', { enabled: false })).status, 401);
  });

  await t.test('admin grants access through user editing; an existing manager session can read all tabs', async () => {
    const result = await request('/users/2', adminToken, 'PATCH', { scopes: ['API_METRICS_VIEW'] });
    assert.equal(result.status, 200);
    assert.deepEqual((await result.json()).scopes, ['API_METRICS_VIEW']);
    for (const endpoint of endpoints) assert.equal((await request(endpoint, managerToken)).status, 200, endpoint);
    assert.equal((await request('/dev-metrics/production-debug', managerToken).then((r) => r.json())).kind, 'production');
  });

  await t.test('viewers cannot change inbound mode or grant themselves additional rights', async () => {
    assert.equal((await request('/dev-metrics/inbound-sync', managerToken, 'PATCH', { enabled: false })).status, 403);
    assert.equal(inboundEnabled, true);
    assert.equal((await request('/users/2', managerToken, 'PATCH', { role: 'ADMIN' })).status, 403);
    assert.equal((await request('/users', managerToken, 'POST', { username: 'injected', name: 'Injected', password: 'test-only' })).status, 403);
    assert.equal(users.get(2).role, 'MANAGER');
    const result = await request('/dev-metrics/inbound-sync', adminToken, 'PATCH', { enabled: false });
    assert.equal(result.status, 200);
    assert.equal((await result.json()).enabled, false);
  });

  await t.test('revoking the scope takes effect for already issued tokens and does not trust stale JWT claims', async () => {
    const staleToken = tokenFor(2, { role: 'ADMIN' });
    assert.equal((await request('/users/2', adminToken, 'PATCH', { scopes: [] })).status, 200);
    for (const endpoint of endpoints) assert.equal((await request(endpoint, staleToken)).status, 403, endpoint);
    assert.equal((await request('/dev-metrics/inbound-sync', staleToken, 'PATCH', { enabled: true })).status, 403);
    assert.equal(inboundEnabled, false);
  });

  await t.test('admin can assign the scope on account creation; invalid scope values remain rejected', async () => {
    const result = await request('/users', adminToken, 'POST', {
      username: 'new-manager', name: 'New Manager', password: 'test-only-password', role: 'MANAGER', scopes: ['API_METRICS_VIEW'],
    });
    assert.equal(result.status, 201);
    const user = await result.json();
    assert.deepEqual(user.scopes, ['API_METRICS_VIEW']);
    assert.equal(user.passwordHash, undefined);
    assert.equal((await request('/dev-metrics', tokenFor(user.id))).status, 200);
    assert.equal((await request('/users/2', adminToken, 'PATCH', { scopes: ['API_METRICS_ADMIN'] })).status, 400);
  });
});
