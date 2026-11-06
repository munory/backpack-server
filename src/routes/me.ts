import { type FastifyPluginAsyncTypebox, Type } from '@fastify/type-provider-typebox';
import { eq } from 'drizzle-orm';

import { authenticate } from '../auth/authenticate.js';
import { verifyPassword } from '../auth/passwords.js';
import { toPublicUser } from '../auth/users.js';
import type { Db } from '../db/client.js';
import { users } from '../db/schema.js';

const UpdateBody = Type.Object(
  {
    /** How the app addresses the person; null or blank clears it. */
    name: Type.Union([Type.Null(), Type.String({ maxLength: 100 })]),
  },
  { additionalProperties: false },
);

const DeleteBody = Type.Object(
  { password: Type.Optional(Type.String({ maxLength: 200 })) },
  { additionalProperties: false },
);

/** GET /me — the signed-in user's own account; PATCH /me — change the name;
 * DELETE /me — remove it. */
export function meRoutes(db: Db): FastifyPluginAsyncTypebox {
  return async (app) => {
    const signInRequired = { error: 'unauthorized', message: 'Sign in required' };

    app.get('/me', { preHandler: authenticate }, async (request, reply) => {
      const [user] = await db.select().from(users).where(eq(users.id, request.user.sub));
      // A valid token for an account deleted since it was issued.
      if (!user) return reply.code(401).send(signInRequired);
      return toPublicUser(user);
    });

    // The only thing editable for now: the optional name, set or changed
    // whenever, from Profile. Nothing else about a person is asked for.
    app.patch('/me', { preHandler: authenticate, schema: { body: UpdateBody } }, async (request, reply) => {
      const name = request.body.name?.trim() || null;
      const [user] = await db.update(users).set({ name }).where(eq(users.id, request.user.sub)).returning();
      if (!user) return reply.code(401).send(signInRequired);
      return toPublicUser(user);
    });

    // Deletes the account and everything in it — gear, trips, sessions, reset
    // codes: every table points at users with ON DELETE CASCADE, so removing
    // the user row removes the rest. Required by Google Play for any app with
    // accounts. Not undoable, so an account with a password must type it —
    // a phone left unlocked on a table shouldn't be enough. Without a password
    // (Google-only) being signed in is all there is to check.
    app.delete('/me', { preHandler: authenticate, schema: { body: DeleteBody } }, async (request, reply) => {
      const [user] = await db.select().from(users).where(eq(users.id, request.user.sub));
      if (!user) return reply.code(401).send(signInRequired);

      if (user.passwordHash) {
        const password = request.body?.password ?? '';
        if (!(await verifyPassword(user.passwordHash, password))) {
          return reply
            .code(403)
            .send({ error: 'wrong_password', message: 'Enter your password to delete the account' });
        }
      }

      await db.delete(users).where(eq(users.id, user.id));
      request.log.info({ userId: user.id }, 'account deleted');
      return reply.code(204).send();
    });
  };
}
