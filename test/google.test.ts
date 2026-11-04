import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp, type App } from '../src/app.js';
import type { GoogleIdentity } from '../src/auth/google.js';
import { createTestDatabase, databaseUrl } from './helpers/testDatabase.js';

const jwtSecret = 'test-secret-that-is-at-least-32-chars';

// Google is faked: an "ID token" here is just a key into this table. Whether
// a real token is genuine is Google's library's job (src/auth/google.ts);
// these tests are about what we do with the person once Google vouches.
const googlePeople: Record<string, GoogleIdentity> = {
  'token-anna': { googleId: 'g-anna', email: 'Anna@Gmail.com', name: 'Anna' },
  'token-boris': { googleId: 'g-boris', email: 'boris@example.com', name: 'Boris' },
  'token-boris-other-google': { googleId: 'g-boris-2', email: 'boris@example.com', name: 'Boris' },
};
const fakeGoogle = async (idToken: string) => googlePeople[idToken] ?? null;

describe.skipIf(!databaseUrl)('sign in with Google', () => {
  let testDb: Awaited<ReturnType<typeof createTestDatabase>>;
  let app: App;

  beforeAll(async () => {
    testDb = await createTestDatabase();
    app = buildApp({ jwtSecret, database: testDb, verifyGoogleToken: fakeGoogle });
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
    await testDb.drop();
  });

  const google = (idToken: string) =>
    app.inject({ method: 'POST', url: '/auth/google', payload: { idToken } });

  it('a first Google sign-in creates an account without a password', async () => {
    const response = await google('token-anna');

    expect(response.statusCode).toBe(200);
    expect(response.json().user).toMatchObject({
      email: 'anna@gmail.com',
      name: 'Anna',
      hasPassword: false,
      hasGoogle: true,
    });
    const me = await app.inject({
      method: 'GET',
      url: '/me',
      headers: { authorization: `Bearer ${response.json().accessToken}` },
    });
    expect(me.json().email).toBe('anna@gmail.com');
  });

  it('signing in with Google again is the same account', async () => {
    const first = await google('token-anna');
    const second = await google('token-anna');

    expect(second.json().user.id).toBe(first.json().user.id);
  });

  it('links Google to a password account with the same email, and retires the password', async () => {
    const signedUp = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { email: 'Boris@Example.com', password: 'set before google' },
    });
    const oldRefresh = signedUp.json().refreshToken;

    const viaGoogle = await google('token-boris');
    expect(viaGoogle.statusCode).toBe(200);
    expect(viaGoogle.json().user).toMatchObject({
      id: signedUp.json().user.id, // same account
      hasGoogle: true,
      hasPassword: false,
    });

    // Whoever set that password — maybe not Boris — is locked out.
    const passwordLogin = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'boris@example.com', password: 'set before google' },
    });
    expect(passwordLogin.statusCode).toBe(401);
    const oldDevice = await app.inject({
      method: 'POST',
      url: '/auth/refresh',
      payload: { refreshToken: oldRefresh },
    });
    expect(oldDevice.statusCode).toBe(401);
  });

  it('won\'t move an email that is already linked to another Google account', async () => {
    const response = await google('token-boris-other-google');

    expect(response.statusCode).toBe(409);
    expect(response.json().error).toBe('email_linked_elsewhere');
  });

  it('a token Google doesn\'t vouch for is refused', async () => {
    const response = await google('forged-token');

    expect(response.statusCode).toBe(401);
    expect(response.json().error).toBe('invalid_google_token');
  });

  it('answers 503 when Google sign-in isn\'t set up on the server', async () => {
    const withoutGoogle = buildApp({ jwtSecret, database: testDb });

    const response = await withoutGoogle.inject({
      method: 'POST',
      url: '/auth/google',
      payload: { idToken: 'token-anna' },
    });

    expect(response.statusCode).toBe(503);
    await withoutGoogle.close();
  });
});
