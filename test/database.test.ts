import { existsSync } from 'node:fs';

import { afterAll, describe, expect, it } from 'vitest';

import { createDatabase } from '../src/db/client.js';

// Talks to the real local database (`npm run db:up`). Skipped when there is
// no DATABASE_URL — e.g. on a machine without the Docker database.
if (existsSync('.env')) process.loadEnvFile('.env');
const url = process.env.DATABASE_URL;

describe.skipIf(!url)('real database', () => {
  const database = createDatabase(url!);
  afterAll(async () => database.close());

  it('answers a query', async () => {
    await expect(database.ping()).resolves.toBeUndefined();
  });
});
