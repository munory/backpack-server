import { buildApp } from './app.js';

// Where to listen, overridable from outside: the VPS sets its own values.
const port = Number(process.env.PORT ?? 3000);
// 127.0.0.1 = this computer only (the Android emulator reaches it as
// 10.0.2.2). On the VPS, inside Docker, it becomes 0.0.0.0 — "accept from
// outside" — set through HOST.
const host = process.env.HOST ?? '127.0.0.1';

const app = buildApp({ logger: true });

// Ctrl+C here, or the VPS stopping the service: let requests in flight
// finish, then exit cleanly instead of cutting them off.
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, async () => {
    await app.close();
    process.exit(0);
  });
}

try {
  await app.listen({ port, host });
} catch (error) {
  app.log.error(error);
  process.exit(1);
}
