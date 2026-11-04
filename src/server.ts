import { existsSync } from 'node:fs';

import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { createDatabase } from './db/client.js';

// Locally, settings live in .env; on the VPS, Docker provides them directly
// and there is no .env file.
if (existsSync('.env')) process.loadEnvFile('.env');

const config = loadConfig();
const database = createDatabase(config.databaseUrl);
const app = buildApp({ logger: true, jwtSecret: config.jwtSecret, database });

// Closing the server closes the database connections with it.
app.addHook('onClose', async () => {
  await database.close();
});

// Ctrl+C here, or the VPS stopping the service: let requests in flight
// finish, then exit cleanly instead of cutting them off.
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, async () => {
    await app.close();
    process.exit(0);
  });
}

try {
  await app.listen({ port: config.port, host: config.host });
} catch (error) {
  app.log.error(error);
  process.exit(1);
}
