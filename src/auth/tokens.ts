import { createHash, randomBytes } from 'node:crypto';

import { and, eq, gt, isNull } from 'drizzle-orm';
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

/**
 * Swaps a refresh token for a new pair ("rotation"): the old one is revoked
 * and works only this once. Revoking and checking happen in one UPDATE, so
 * two requests racing with the same token can't both get through.
 *
 * Returns null when the token is no good. If it's a token that was already
 * used, someone else has a copy — whoever came first, the other is a thief —
 * so every token of that user is revoked and all their devices must sign in
 * again.
 */
export async function rotateRefreshToken(
  app: FastifyInstance,
  db: Db,
  refreshToken: string,
): Promise<{ userId: string; tokens: Tokens } | null> {
  const tokenHash = hashToken(refreshToken);
  const [revoked] = await db
    .update(refreshTokens)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(refreshTokens.tokenHash, tokenHash),
        isNull(refreshTokens.revokedAt),
        gt(refreshTokens.expiresAt, new Date()),
      ),
    )
    .returning({ userId: refreshTokens.userId });

  if (revoked) {
    return { userId: revoked.userId, tokens: await issueTokens(app, db, revoked.userId) };
  }

  const [reused] = await db
    .select({ userId: refreshTokens.userId, revokedAt: refreshTokens.revokedAt })
    .from(refreshTokens)
    .where(eq(refreshTokens.tokenHash, tokenHash));
  if (reused?.revokedAt) {
    app.log.warn({ userId: reused.userId }, 'refresh token reused — revoking all of the user\'s tokens');
    await revokeAllTokens(db, reused.userId);
  }
  return null;
}

/** Signs this device out: its refresh token stops working. Unknown or
 * already-revoked tokens are fine — signing out twice is not an error. */
export async function revokeRefreshToken(db: Db, refreshToken: string): Promise<void> {
  await db
    .update(refreshTokens)
    .set({ revokedAt: new Date() })
    .where(and(eq(refreshTokens.tokenHash, hashToken(refreshToken)), isNull(refreshTokens.revokedAt)));
}

/** Signs the user out everywhere. */
export async function revokeAllTokens(db: Db, userId: string): Promise<void> {
  await db
    .update(refreshTokens)
    .set({ revokedAt: new Date() })
    .where(and(eq(refreshTokens.userId, userId), isNull(refreshTokens.revokedAt)));
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
