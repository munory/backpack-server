import { randomBytes } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp, type App } from '../src/app.js';
import { hashToken } from '../src/auth/tokens.js';
import { refreshTokens } from '../src/db/schema.js';
import { createTestDatabase, databaseUrl } from './helpers/testDatabase.js';
import { createInbox, signUp as signUpWithCode } from './helpers/signUp.js';

describe.skipIf(!databaseUrl)('renewing and signing out', () => {
  let testDb: Awaited<ReturnType<typeof createTestDatabase>>;
  let app: App;
  const inbox = createInbox();

  beforeAll(async () => {
    testDb = await createTestDatabase();
    app = buildApp({ rateLimit: false, jwtSecret: 'test-secret-that-is-at-least-32-chars', database: testDb, sendMail: inbox.sendMail });
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
    await testDb.drop();
  });

  let accounts = 0;
  /** A fresh account; returns its id and first pair of tokens. */
  const signUp = async () => {
    const response = await signUpWithCode(app, inbox, `user${++accounts}@example.com`, 'long enough');
    const body = response.json();
    return { userId: body.user.id as string, refreshToken: body.refreshToken as string };
  };
  const refresh = (refreshToken: string) =>
    app.inject({ method: 'POST', url: '/auth/refresh', payload: { refreshToken } });
  const logout = (refreshToken: string) =>
    app.inject({ method: 'POST', url: '/auth/logout', payload: { refreshToken } });

  it('swaps a refresh token for a new pair that works', async () => {
    const { refreshToken } = await signUp();

    const renewed = await refresh(refreshToken);
    expect(renewed.statusCode).toBe(200);
    const { accessToken, refreshToken: next } = renewed.json();
    expect(next).not.toBe(refreshToken);

    const me = await app.inject({
      method: 'GET',
      url: '/me',
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(me.statusCode).toBe(200);
    expect((await refresh(next)).statusCode).toBe(200);
  });

  it('a refresh token works only once', async () => {
    const { refreshToken } = await signUp();
    await refresh(refreshToken);

    const again = await refresh(refreshToken);
    expect(again.statusCode).toBe(401);
    expect(again.json().error).toBe('invalid_refresh_token');
  });

  it('reusing a spent token signs the user out everywhere — someone has a copy', async () => {
    const { refreshToken: stolen } = await signUp();
    // The real owner renews first and carries on with the new token…
    const ownersToken = (await refresh(stolen)).json().refreshToken;

    // …then the thief tries the copy.
    expect((await refresh(stolen)).statusCode).toBe(401);

    // Now even the owner's current token is dead: sign in again.
    expect((await refresh(ownersToken)).statusCode).toBe(401);
  });

  it('signing out stops the token working, and twice is fine', async () => {
    const { refreshToken } = await signUp();

    expect((await logout(refreshToken)).statusCode).toBe(204);
    expect((await logout(refreshToken)).statusCode).toBe(204);
    expect((await refresh(refreshToken)).statusCode).toBe(401);
  });

  it('an expired refresh token is refused', async () => {
    const { userId } = await signUp();
    const expired = randomBytes(32).toString('base64url');
    await testDb.db.insert(refreshTokens).values({
      userId,
      tokenHash: hashToken(expired),
      expiresAt: new Date(Date.now() - 1000),
    });

    expect((await refresh(expired)).statusCode).toBe(401);
  });

  it('a made-up token is refused, and no token at all is bad input', async () => {
    expect((await refresh('not-a-real-token')).statusCode).toBe(401);

    const missing = await app.inject({ method: 'POST', url: '/auth/refresh', payload: {} });
    expect(missing.statusCode).toBe(400);
  });
});
