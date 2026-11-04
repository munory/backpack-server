import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { eq } from 'drizzle-orm';

import { authenticate } from '../auth/authenticate.js';
import { toPublicUser } from '../auth/users.js';
import type { Db } from '../db/client.js';
import { users } from '../db/schema.js';

/** GET /me — the signed-in user's own account. */
export function meRoutes(db: Db): FastifyPluginAsyncTypebox {
  return async (app) => {
    app.get('/me', { preHandler: authenticate }, async (request, reply) => {
      const [user] = await db.select().from(users).where(eq(users.id, request.user.sub));
      // A valid token for an account deleted since it was issued.
      if (!user) {
        return reply.code(401).send({ error: 'unauthorized', message: 'Sign in required' });
      }
      return toPublicUser(user);
    });
  };
}
