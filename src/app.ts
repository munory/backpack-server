import Fastify, { type FastifyInstance } from 'fastify';

export interface AppOptions {
  logger?: boolean;
  /**
   * Checks the database is reachable. Passed in rather than created here, so
   * tests can hand in a fake one — up or down — without a real database.
   */
  pingDatabase: () => Promise<void>;
}

/**
 * Builds the server: creates Fastify and registers every route. Kept apart
 * from starting it (see server.ts) so tests can call the routes directly,
 * without opening a real port.
 */
export function buildApp(options: AppOptions): FastifyInstance {
  const app = Fastify({ logger: options.logger ?? false });

  // Liveness check — the server is up and can reach its database. Handy to
  // check in a browser now; later, uptime monitoring on the VPS will ping it.
  // 503 "Service Unavailable" when the database is down, so monitoring
  // notices.
  app.get('/health', async (request, reply) => {
    try {
      await options.pingDatabase();
      return { status: 'ok', database: 'ok' };
    } catch (error) {
      request.log.error(error, 'database is unreachable');
      return reply.code(503).send({ status: 'error', database: 'unreachable' });
    }
  });

  return app;
}
