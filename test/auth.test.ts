import { createSigner } from 'fast-jwt';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp, type App } from '../src/app.js';
import { users } from '../src/db/schema.js';
import { createTestDatabase, databaseUrl } from './helpers/testDatabase.js';

const jwtSecret = 'test-secret-that-is-at-least-32-chars';

describe.skipIf(!databaseUrl)('accounts with email and password', () => {
  let testDb: Awaited<ReturnType<typeof createTestDatabase>>;
  let app: App;

  beforeAll(async () => {
    testDb = await createTestDatabase();
    app = buildApp({ jwtSecret, database: testDb });
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
    await testDb.drop();
  });

  const register = (email: string, password: string) =>
    app.inject({ method: 'POST', url: '/auth/register', payload: { email, password } });
  const login = (email: string, password: string) =>
    app.inject({ method: 'POST', url: '/auth/login', payload: { email, password } });
  const me = (token?: string) =>
    app.inject({
      method: 'GET',
      url: '/me',
      headers: token ? { authorization: `Bearer ${token}` } : {},
    });

  it('register → sign in → "who am I"', async () => {
    const registered = await register('Kate@Example.com', 'correct horse');
    expect(registered.statusCode).toBe(201);
    expect(registered.json().user).toMatchObject({
      email: 'kate@example.com', // stored lowercased
      hasPassword: true,
      hasGoogle: false,
    });
    expect(registered.json().accessToken).toEqual(expect.any(String));
    expect(registered.json().refreshToken).toEqual(expect.any(String));

    // Any spelling of the same email signs in to the same account.
    const signedIn = await login('  KATE@example.com ', 'correct horse');
    expect(signedIn.statusCode).toBe(200);
    expect(signedIn.json().user.id).toBe(registered.json().user.id);

    const whoAmI = await me(signedIn.json().accessToken);
    expect(whoAmI.statusCode).toBe(200);
    expect(whoAmI.json().email).toBe('kate@example.com');
  });

  it('stores an argon2id hash, never the password itself', async () => {
    await register('hash@example.com', 'my secret pass');

    const [row] = await testDb.db.select().from(users).where(eq(users.email, 'hash@example.com'));
    expect(row!.passwordHash).toMatch(/^\$argon2id\$/);
    expect(row!.passwordHash).not.toContain('my secret pass');
  });

  it('refuses a second account with the same email', async () => {
    await register('twice@example.com', 'first password');

    const again = await register('TWICE@example.com', 'other password');
    expect(again.statusCode).toBe(409);
    expect(again.json().error).toBe('email_taken');
  });

  it('a wrong password and an unknown email get the very same answer', async () => {
    await register('probe@example.com', 'right password');

    const wrongPassword = await login('probe@example.com', 'wrong password');
    const unknownEmail = await login('nobody@example.com', 'right password');

    expect(wrongPassword.statusCode).toBe(401);
    expect(unknownEmail.statusCode).toBe(401);
    expect(unknownEmail.json()).toEqual(wrongPassword.json());
  });

  it('rejects bad input with 400 before touching the database', async () => {
    const notAnEmail = await register('not-an-email', 'long enough');
    const shortPassword = await register('short@example.com', 'short');

    for (const response of [notAnEmail, shortPassword]) {
      expect(response.statusCode).toBe(400);
      expect(response.json().error).toBe('invalid_input');
    }
  });

  it('drops fields it doesn\'t know instead of passing them on', async () => {
    // Fastify strips anything not in the schema before our code sees it —
    // so "isAdmin" can't sneak in, and a newer app sending a new field
    // doesn't break an older server.
    const response = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { email: 'extra@example.com', password: 'long enough', isAdmin: true },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json().user).not.toHaveProperty('isAdmin');
  });

  describe('"who am I" needs a valid access token', () => {
    it('no token → 401', async () => {
      expect((await me()).statusCode).toBe(401);
    });

    it('a token signed with someone else\'s key → 401', async () => {
      const forged = createSigner({ key: 'a-different-secret-of-32-characters!!' })({
        sub: 'any',
      });
      expect((await me(forged)).statusCode).toBe(401);
    });

    it('an expired token → 401', async () => {
      const registered = await register('expired@example.com', 'long enough');
      // Signed with our real key, but issued two hours ago — so its
      // 15 minutes ran out long ago.
      const expired = createSigner({
        key: jwtSecret,
        expiresIn: 15 * 60 * 1000,
        clockTimestamp: Date.now() - 2 * 60 * 60 * 1000,
      })({ sub: registered.json().user.id });
      expect((await me(expired)).statusCode).toBe(401);
    });
  });
});
