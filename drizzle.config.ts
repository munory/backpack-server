import { existsSync } from 'node:fs';

import { defineConfig } from 'drizzle-kit';

// drizzle-kit compares src/db/schema.ts with what it generated before and
// writes the difference as a new SQL migration into drizzle/ — committed to
// git, and applied the same way locally and on the VPS.
if (existsSync('.env')) process.loadEnvFile('.env');

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema.ts',
  out: './drizzle',
  dbCredentials: { url: process.env.DATABASE_URL! },
});
