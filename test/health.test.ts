import { afterAll, describe, expect, it } from 'vitest';

import { buildApp } from '../src/app.js';

// `inject` sends a request straight into the app — no real port, no network —
// so tests are fast and can't clash with a server running on the same machine.
describe('GET /health', () => {
  const app = buildApp();
  afterAll(async () => app.close());

  it('answers 200 with status ok', async () => {
    const response = await app.inject({ method: 'GET', url: '/health' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok' });
  });

  it('answers 404 for a route that does not exist', async () => {
    const response = await app.inject({ method: 'GET', url: '/nope' });

    expect(response.statusCode).toBe(404);
  });
});
