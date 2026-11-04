import { existsSync } from 'node:fs';

import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';

if (existsSync('.env')) process.loadEnvFile('.env');

/** The local database's URL, or undefined when there is none (tests skip). */
export const databaseUrl = process.env.DATABASE_URL;

/**
 * A brand-new throwaway database with every migration applied — never the
 * working one. Each test file gets its own, so files can run side by side.
 * Call `drop()` when done.
 */
export async function createTestDatabase() {
  const name = `backpack_test_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  const admin = postgres(databaseUrl!, { max: 1 });
  await admin.unsafe(`CREATE DATABASE ${name}`);

  const url = new URL(databaseUrl!);
  url.pathname = `/${name}`;
  const client = postgres(url.toString(), { max: 5, onnotice: () => {} });
  const db = drizzle(client);
  await migrate(db, { migrationsFolder: 'drizzle' });

  return {
    db,
    ping: async () => {
      await client`select 1`;
    },
    async drop() {
      await client.end();
      await admin.unsafe(`DROP DATABASE ${name}`);
      await admin.end();
    },
  };
}
