import fastifyJwt from '@fastify/jwt';
import rateLimit from '@fastify/rate-limit';
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import Fastify, { type FastifyError } from 'fastify';

import type { VerifyGoogleToken } from './auth/google.js';
import { ACCESS_TOKEN_TTL } from './auth/tokens.js';
import type { Db } from './db/client.js';
import type { SendMail } from './mail/mailer.js';
import { authRoutes } from './routes/auth.js';
import { googleRoutes } from './routes/google.js';
import { meRoutes } from './routes/me.js';
import { passwordResetRoutes } from './routes/passwordReset.js';
import { signupRoutes } from './routes/signup.js';
import { syncRoutes } from './routes/sync.js';
import { RATE_LIMITS } from './rateLimits.js';

/**
 * Never written to the server's log, even if some log line includes a
 * request body or headers: passwords, codes and tokens would otherwise sit
 * in plain text in log files, where anyone reading logs could use them.
 */
const SECRETS = [
  'req.headers.authorization',
  '*.password',
  '*.newPassword',
  // The reset code only where a request body would be: a bare "code" is
  // also an error's code (EADDRINUSE, …), which logs must keep.
  '*.body.code',
  '*.refreshToken',
  '*.accessToken',
  '*.idToken',
];

export interface AppOptions {
  logger?: boolean;
  /**
   * Limits how often one address may call each route (see rateLimits.ts).
   * On unless turned off — only tests that make many requests in a row do.
   */
  rateLimit?: boolean;
  /**
   * On the VPS, Caddy (https) passes requests on, so every request seems to
   * come from Caddy's address. Trusting it makes the server read the real
   * phone's address from the X-Forwarded-For header Caddy adds — otherwise
   * all users would share one rate limit. Never trust it without a proxy in
   * front: anyone could then fake their address. From TRUST_PROXY.
   */
  trustProxy?: boolean | string;
  /** Signs access tokens (from JWT_SECRET). */
  jwtSecret: string;
  /**
   * Checks Google ID tokens (stage 7). Passed in so tests can fake Google;
   * absent when GOOGLE_CLIENT_ID isn't set — Google sign-in then answers 503.
   */
  verifyGoogleToken?: VerifyGoogleToken;
  /**
   * Sends email (password reset codes). Passed in so tests can catch mail;
   * absent when SMTP_URL isn't set — reset then answers 503.
   */
  sendMail?: SendMail;
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
  const app = Fastify({
    logger: options.logger ? { redact: { paths: SECRETS, censor: '[hidden]' } } : false,
    trustProxy: options.trustProxy ?? false,
    // Sign-in and the like are a few hundred bytes; refusing anything big
    // early stops junk from eating memory. /sync allows more on its own.
    bodyLimit: 64 * 1024,
  }).withTypeProvider<TypeBoxTypeProvider>();

  if (options.rateLimit ?? true) {
    app.register(rateLimit, RATE_LIMITS.default);
  }

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
    if (error.statusCode === 429) {
      // The retry-after header (seconds to wait) is already set.
      return reply
        .code(429)
        .send({ error: 'too_many_requests', message: 'Too many attempts, try again in a minute' });
    }
    if (error.statusCode === 413) {
      return reply.code(413).send({ error: 'too_large', message: 'Request is too large' });
    }
    if (error.statusCode && error.statusCode < 500) {
      // The phone sent something broken (not JSON, …) — its problem, not a crash.
      return reply.code(error.statusCode).send({ error: 'bad_request', message: error.message });
    }
    request.log.error(error);
    return reply.code(500).send({ error: 'server_error', message: 'Something went wrong' });
  });

  // Liveness check — the server is up and can reach its database. Handy to
  // check in a browser now; later, uptime monitoring on the VPS will ping it.
  // 503 "Service Unavailable" when the database is down, so monitoring
  // notices. Routes are added inside plugins registered after the rate
  // limiter, so every route gets a limit.
  app.register(async (app) => {
    app.get('/health', async (request, reply) => {
      try {
        await options.database.ping();
        return { status: 'ok', database: 'ok' };
      } catch (error) {
        request.log.error(error, 'database is unreachable');
        return reply.code(503).send({ status: 'error', database: 'unreachable' });
      }
    });
  });

  app.register(authRoutes(options.database.db));
  app.register(signupRoutes({ db: options.database.db, sendMail: options.sendMail, secret: options.jwtSecret }));
  app.register(googleRoutes(options.database.db, options.verifyGoogleToken));
  app.register(
    passwordResetRoutes({
      db: options.database.db,
      sendMail: options.sendMail,
      secret: options.jwtSecret,
    }),
  );
  app.register(meRoutes(options.database.db));
  app.register(syncRoutes(options.database.db));

  return app;
}

export type App = ReturnType<typeof buildApp>;
