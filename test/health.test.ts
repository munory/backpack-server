import { describe, expect, it } from 'vitest';

import { buildApp } from '../src/app.js';
import type { Db } from '../src/db/client.js';

// `inject` sends a request straight into the app — no real port, no network —
// so tests are fast and can't clash with a server running on the same machine.
// The database is faked here: these tests are about what /health answers, and
// /health only ever pings it.
const appWith = (ping: () => Promise<void>) =>
  buildApp({
    jwtSecret: 'test-secret-that-is-at-least-32-chars',
    database: { db: undefined as unknown as Db, ping },
  });

describe('GET /health', () => {
  it('answers 200 when the database is reachable', async () => {
    const app = appWith(async () => {});

    const response = await app.inject({ method: 'GET', url: '/health' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok', database: 'ok' });
    await app.close();
  });

  it('answers 503 when the database is down', async () => {
    const app = appWith(async () => {
      throw new Error('connection refused');
    });

    const response = await app.inject({ method: 'GET', url: '/health' });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ status: 'error', database: 'unreachable' });
    await app.close();
  });

  it('answers 404 for a route that does not exist', async () => {
    const app = appWith(async () => {});

    const response = await app.inject({ method: 'GET', url: '/nope' });

    expect(response.statusCode).toBe(404);
    await app.close();
  });
});
