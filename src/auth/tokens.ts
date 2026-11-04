import { createHash, randomBytes } from 'node:crypto';

import type { FastifyInstance } from 'fastify';

import type { Db } from '../db/client.js';
import { refreshTokens } from '../db/schema.js';

/**
 * A signed-in device holds two tokens:
 * - access token — a JWT sent with every request, valid 15 minutes. The
 *   server checks its signature only, without the database — fast.
 * - refresh token — a long random string, valid 30 days, used only to get a
 *   new access token (stage 6). Stored in the database as a hash, so it can
 *   be revoked: on sign out, or if a phone is lost.
 * If an access token leaks it's useless within 15 minutes; a refresh token
 * can be cut off at any time.
 */
export const ACCESS_TOKEN_TTL = '15m';
export const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export interface Tokens {
  accessToken: string;
  refreshToken: string;
}

/**
 * SHA-256, not argon2: a refresh token is 32 random bytes, so there's nothing
 * to guess — a fast hash is enough. Passwords need a slow one only because
 * people pick guessable ones.
 */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Issues a fresh pair for the user and stores the refresh token's hash. */
export async function issueTokens(app: FastifyInstance, db: Db, userId: string): Promise<Tokens> {
  const refreshToken = randomBytes(32).toString('base64url');
  await db.insert(refreshTokens).values({
    userId,
    tokenHash: hashToken(refreshToken),
    expiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL_MS),
  });
  return {
    accessToken: app.jwt.sign({ sub: userId }),
    refreshToken,
  };
}
