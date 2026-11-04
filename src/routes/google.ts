import { type FastifyPluginAsyncTypebox, Type } from '@fastify/type-provider-typebox';
import { and, eq, isNull } from 'drizzle-orm';

import type { VerifyGoogleToken } from '../auth/google.js';
import { issueTokens } from '../auth/tokens.js';
import { normalizeEmail, toPublicUser } from '../auth/users.js';
import type { Db } from '../db/client.js';
import { refreshTokens, users } from '../db/schema.js';

const GoogleBody = Type.Object(
  { idToken: Type.String({ minLength: 1, maxLength: 4096 }) },
  { additionalProperties: false },
);

/**
 * POST /auth/google — the app sends the ID token Google gave it; we check it
 * and sign the person in, creating or linking the account:
 * 1. Signed in with this Google account before → that account.
 * 2. An account with the same email exists (signed up with a password) →
 *    the same person, so Google is linked to it. Google has verified they own
 *    the email; the password set at sign-up never proved that — anyone could
 *    have registered someone else's email first and be waiting for them to
 *    show up. So linking also removes that password and signs out every
 *    device: whoever set it is locked out. The real owner can set a new one
 *    with "forgot password" — which goes to the email they do own.
 * 3. Neither → a new account, no password.
 */
export function googleRoutes(db: Db, verify: VerifyGoogleToken | undefined): FastifyPluginAsyncTypebox {
  return async (app) => {
    app.post('/auth/google', { schema: { body: GoogleBody } }, async (request, reply) => {
      if (!verify) {
        return reply
          .code(503)
          .send({ error: 'google_not_configured', message: 'Google sign-in is not set up' });
      }
      const identity = await verify(request.body.idToken);
      if (!identity) {
        return reply
          .code(401)
          .send({ error: 'invalid_google_token', message: 'Google sign-in failed' });
      }
      const email = normalizeEmail(identity.email);

      const outcome = await db.transaction(async (tx) => {
        const [byGoogle] = await tx.select().from(users).where(eq(users.googleId, identity.googleId));
        if (byGoogle) return { user: byGoogle };

        const [byEmail] = await tx.select().from(users).where(eq(users.email, email));
        if (byEmail) {
          // Already tied to a different Google account — don't guess.
          if (byEmail.googleId) return { conflict: true as const };
          await tx
            .update(refreshTokens)
            .set({ revokedAt: new Date() })
            .where(and(eq(refreshTokens.userId, byEmail.id), isNull(refreshTokens.revokedAt)));
          const [linked] = await tx
            .update(users)
            .set({ googleId: identity.googleId, name: byEmail.name ?? identity.name, passwordHash: null })
            .where(eq(users.id, byEmail.id))
            .returning();
          return { user: linked! };
        }

        const [created] = await tx
          .insert(users)
          .values({ email, googleId: identity.googleId, name: identity.name })
          .returning();
        return { user: created! };
      });

      if ('conflict' in outcome) {
        return reply.code(409).send({
          error: 'email_linked_elsewhere',
          message: 'This email is already linked to a different Google account',
        });
      }
      const tokens = await issueTokens(app, db, outcome.user.id);
      return { user: toPublicUser(outcome.user), ...tokens };
    });
  };
}
