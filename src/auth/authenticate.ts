import type { FastifyReply, FastifyRequest } from 'fastify';

// What our access tokens carry: just the user's id ("subject"). Nothing
// private goes in a JWT — anyone holding it can read it; only the signature
// stops it being forged.
declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: { sub: string };
    user: { sub: string };
  }
}

/**
 * Guard for routes that need a signed-in user: expects
 * `Authorization: Bearer <access token>`, checks its signature and expiry, and
 * puts the user id on `request.user.sub`. Anything else — no token, a forged
 * or expired one — is 401.
 */
export async function authenticate(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  try {
    await request.jwtVerify();
  } catch {
    return reply.code(401).send({ error: 'unauthorized', message: 'Sign in required' });
  }
}
