import fastifyJwt from '@fastify/jwt';
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import Fastify, { type FastifyError } from 'fastify';

import type { VerifyGoogleToken } from './auth/google.js';
import { ACCESS_TOKEN_TTL } from './auth/tokens.js';
import type { Db } from './db/client.js';
import { authRoutes } from './routes/auth.js';
import { googleRoutes } from './routes/google.js';
import { meRoutes } from './routes/me.js';

export interface AppOptions {
  logger?: boolean;
  /** Signs access tokens (from JWT_SECRET). */
  jwtSecret: string;
  /**
   * Checks Google ID tokens (stage 7). Passed in so tests can fake Google;
   * absent when GOOGLE_CLIENT_ID isn't set — Google sign-in then answers 503.
   */
  verifyGoogleToken?: VerifyGoogleToken;
  /**
   * The database, passed in rather than created here — tests hand in a
   * throwaway database, or a fake `ping` for what /health answers.
   */
  database: {
    db: Db;
    ping: () => Promise<void>;
  };
}

/**
 * Builds the server: creates Fastify and registers every route. Kept apart
 * from starting it (see server.ts) so tests can call the routes directly,
 * without opening a real port.
 */
export function buildApp(options: AppOptions) {
  const app = Fastify({ logger: options.logger ?? false }).withTypeProvider<TypeBoxTypeProvider>();

  app.register(fastifyJwt, {
    secret: options.jwtSecret,
    sign: { expiresIn: ACCESS_TOKEN_TTL },
  });

  // Requests that don't fit a route's schema (not an email, password too
  // short, …) get one consistent shape the app can rely on: an error code to
  // show a translated message for, plus a detail for developers.
  app.setErrorHandler((error: FastifyError, request, reply) => {
    if (error.validation) {
      return reply.code(400).send({ error: 'invalid_input', message: error.message });
    }
    request.log.error(error);
    return reply
      .code(error.statusCode ?? 500)
      .send({ error: 'server_error', message: 'Something went wrong' });
  });

  // Liveness check — the server is up and can reach its database. Handy to
  // check in a browser now; later, uptime monitoring on the VPS will ping it.
  // 503 "Service Unavailable" when the database is down, so monitoring
  // notices.
  app.get('/health', async (request, reply) => {
    try {
      await options.database.ping();
      return { status: 'ok', database: 'ok' };
    } catch (error) {
      request.log.error(error, 'database is unreachable');
      return reply.code(503).send({ status: 'error', database: 'unreachable' });
    }
  });

  app.register(authRoutes(options.database.db));
  app.register(googleRoutes(options.database.db, options.verifyGoogleToken));
  app.register(meRoutes(options.database.db));

  return app;
}

export type App = ReturnType<typeof buildApp>;
