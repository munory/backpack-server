import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { eq } from 'drizzle-orm';

import { authenticate } from '../auth/authenticate.js';
import type { Db } from '../db/client.js';
import { users } from '../db/schema.js';
import { sync } from '../sync/sync.js';
import { SyncRequest } from '../sync/wire.js';

/**
 * POST /sync — one call does both directions: the phone sends what changed
 * on it since last time, and gets back what changed on the server since its
 * cursor (made on its other devices). See src/sync/sync.ts for the rules.
 */
export function syncRoutes(db: Db): FastifyPluginAsyncTypebox {
  return async (app) => {
    app.post(
      '/sync',
      {
        preHandler: authenticate,
        // A full first upload can be big: up to 1000 rows of each kind.
        bodyLimit: 5 * 1024 * 1024,
        schema: { body: SyncRequest },
      },
      async (request, reply) => {
        const [user] = await db.select({ id: users.id }).from(users).where(eq(users.id, request.user.sub));
        // A valid token for an account deleted since it was issued.
        if (!user) return reply.code(401).send({ error: 'unauthorized', message: 'Sign in required' });

        return sync(db, user.id, request.body);
      },
    );
  };
}
