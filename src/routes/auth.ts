import { type FastifyPluginAsyncTypebox, Type } from '@fastify/type-provider-typebox';
import { eq } from 'drizzle-orm';

import { hashPassword, verifyAgainstNothing, verifyPassword } from '../auth/passwords.js';
import { issueTokens, revokeRefreshToken, rotateRefreshToken } from '../auth/tokens.js';
import { normalizeEmail, toPublicUser } from '../auth/users.js';
import type { Db } from '../db/client.js';
import { RATE_LIMITS } from '../rateLimits.js';
import { users } from '../db/schema.js';

// What each route accepts. Fastify checks every request against these before
// our code runs, and answers 400 itself if something doesn't fit — so inside
// the handlers `email` and `password` are already known to be valid strings.
const RegisterBody = Type.Object(
  {
    email: Type.String({ format: 'email', maxLength: 254 }),
    password: Type.String({ minLength: 8, maxLength: 200 }),
  },
  { additionalProperties: false },
);

// No length rule at sign-in beyond "not empty": reporting it would hint at
// the policy, and an old account may predate a stricter one.
const LoginBody = Type.Object(
  {
    email: Type.String({ maxLength: 254 }),
    password: Type.String({ minLength: 1, maxLength: 200 }),
  },
  { additionalProperties: false },
);

const RefreshBody = Type.Object(
  { refreshToken: Type.String({ minLength: 1, maxLength: 200 }) },
  { additionalProperties: false },
);

/** POST /auth/register, /auth/login, /auth/refresh and /auth/logout. */
export function authRoutes(db: Db): FastifyPluginAsyncTypebox {
  return async (app) => {
    app.post('/auth/register', { config: { rateLimit: RATE_LIMITS.register }, schema: { body: RegisterBody } }, async (request, reply) => {
      const email = normalizeEmail(request.body.email);
      const passwordHash = await hashPassword(request.body.password);

      // The unique email constraint decides "already taken" — no separate
      // look-up first, so two sign-ups at the same moment can't both win.
      const [user] = await db
        .insert(users)
        .values({ email, passwordHash })
        .onConflictDoNothing({ target: users.email })
        .returning();
      if (!user) {
        return reply
          .code(409)
          .send({ error: 'email_taken', message: 'An account with this email already exists' });
      }

      const tokens = await issueTokens(app, db, user.id);
      return reply.code(201).send({ user: toPublicUser(user), ...tokens });
    });

    app.post('/auth/login', { config: { rateLimit: RATE_LIMITS.login }, schema: { body: LoginBody } }, async (request, reply) => {
      const email = normalizeEmail(request.body.email);
      const [user] = await db.select().from(users).where(eq(users.email, email));

      // Same answer, and the same time spent, whether the email doesn't
      // exist, has no password (Google-only), or the password is wrong —
      // otherwise anyone could probe which emails have accounts.
      const valid = user?.passwordHash
        ? await verifyPassword(user.passwordHash, request.body.password)
        : await verifyAgainstNothing(request.body.password);
      if (!user || !valid) {
        return reply
          .code(401)
          .send({ error: 'invalid_credentials', message: 'Wrong email or password' });
      }

      const tokens = await issueTokens(app, db, user.id);
      return { user: toPublicUser(user), ...tokens };
    });

    // The app calls this when its 15-minute access token runs out: the old
    // refresh token goes in, a new pair comes out, and the old one is spent.
    app.post('/auth/refresh', { config: { rateLimit: RATE_LIMITS.refresh }, schema: { body: RefreshBody } }, async (request, reply) => {
      const rotated = await rotateRefreshToken(app, db, request.body.refreshToken);
      if (!rotated) {
        return reply
          .code(401)
          .send({ error: 'invalid_refresh_token', message: 'Sign in again' });
      }
      return rotated.tokens;
    });

    // 204 "No Content": done, nothing to send back — whether or not the
    // token was still valid, so signing out twice is fine.
    app.post('/auth/logout', { schema: { body: RefreshBody } }, async (request, reply) => {
      await revokeRefreshToken(db, request.body.refreshToken);
      return reply.code(204).send();
    });
  };
}
