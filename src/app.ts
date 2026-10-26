import Fastify, { type FastifyInstance } from 'fastify';

/**
 * Builds the server: creates Fastify and registers every route. Kept apart
 * from starting it (see server.ts) so tests can call the routes directly,
 * without opening a real port.
 */
export function buildApp(options: { logger?: boolean } = {}): FastifyInstance {
  const app = Fastify({ logger: options.logger ?? false });

  // Liveness check — answers as long as the server is up. Handy to check in
  // a browser now; later, uptime monitoring on the VPS will ping it.
  app.get('/health', async () => ({ status: 'ok' }));

  return app;
}
