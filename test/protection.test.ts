import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp, type App } from '../src/app.js';
import { RATE_LIMITS } from '../src/rateLimits.js';
import { createTestDatabase, databaseUrl } from './helpers/testDatabase.js';
import { createInbox, signUp } from './helpers/signUp.js';

const jwtSecret = 'test-secret-that-is-at-least-32-chars';

describe.skipIf(!databaseUrl)('protection against abuse', () => {
  let testDb: Awaited<ReturnType<typeof createTestDatabase>>;
  let app: App;
  const inbox = createInbox();

  beforeAll(async () => {
    testDb = await createTestDatabase();
    app = buildApp({ jwtSecret, database: testDb, sendMail: inbox.sendMail });
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
    await testDb.drop();
  });

  /** A request from a given address — each test uses its own, so limits don't mix. */
  const from = (remoteAddress: string, url: string, payload: unknown, headers = {}) =>
    app.inject({ method: 'POST', url, payload: payload as object, remoteAddress, headers });

  it('the 11th sign-in attempt in a minute from one address → 429', async () => {
    const guess = { email: 'kate@example.com', password: 'guess 1234' };
    for (let i = 0; i < RATE_LIMITS.login.max; i++) {
      expect((await from('10.0.0.1', '/auth/login', guess)).statusCode).toBe(401);
    }

    const blocked = await from('10.0.0.1', '/auth/login', guess);
    expect(blocked.statusCode).toBe(429);
    expect(blocked.json().error).toBe('too_many_requests');
    // Tells the app how many seconds to wait.
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);

    // Someone else, elsewhere, is not affected.
    expect((await from('10.0.0.2', '/auth/login', guess)).statusCode).toBe(401);
  });

  it('reset codes can not be requested over and over', async () => {
    const body = { email: 'anna@example.com' };
    for (let i = 0; i < RATE_LIMITS.resetRequest.max; i++) {
      expect((await from('10.0.1.1', '/auth/password-reset/request', body)).statusCode).toBe(202);
    }
    expect((await from('10.0.1.1', '/auth/password-reset/request', body)).statusCode).toBe(429);
  });

  it('behind a trusted proxy, limits go by the real phone address', async () => {
    const proxied = buildApp({ jwtSecret, database: testDb, trustProxy: '127.0.0.1' });
    const guess = { email: 'boris@example.com', password: 'guess 1234' };
    const viaProxy = (phone: string) =>
      proxied.inject({
        method: 'POST', url: '/auth/login', payload: guess,
        remoteAddress: '127.0.0.1', headers: { 'x-forwarded-for': phone },
      });

    for (let i = 0; i < RATE_LIMITS.login.max; i++) await viaProxy('203.0.113.5');
    expect((await viaProxy('203.0.113.5')).statusCode).toBe(429);
    // Same proxy, a different phone — fine.
    expect((await viaProxy('203.0.113.6')).statusCode).toBe(401);
    await proxied.close();
  });

  it('refuses an oversized request', async () => {
    const huge = { email: 'a@example.com', password: 'x'.repeat(100 * 1024) };
    const response = await from('10.0.2.1', '/auth/login', huge);
    expect(response.statusCode).toBe(413);
    expect(response.json().error).toBe('too_large');
  });

  it('answers broken JSON with 400, not a server error', async () => {
    const response = await from('10.0.3.1', '/auth/login', '{"email": oops', {
      'content-type': 'application/json',
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe('bad_request');
  });

  it('still lets a big first sync through', async () => {
    const accessToken = (await signUp(app, inbox, 'lena@example.com', 'my password', {
      remoteAddress: '10.0.4.1',
    })).json().accessToken;
    const items = Array.from({ length: 1000 }, (_, i) => ({
      uuid: randomUUID(), name: `Вещь номер ${i}`, weightGrams: 100, categoryUuid: randomUUID(),
      condition: 0, packType: 1, quantity: 1, worn: false, updatedAt: Date.now(),
    }));
    const payload = { cursor: 0, changes: { categories: [], items, trips: [], tripItems: [] } };
    expect(JSON.stringify(payload).length).toBeGreaterThan(64 * 1024);

    const response = await from('10.0.4.1', '/sync', payload, { authorization: `Bearer ${accessToken}` });
    expect(response.statusCode).toBe(200);
  });
});
