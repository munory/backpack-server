import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { buildApp, type App } from '../src/app.js';
import { passwordResets, users } from '../src/db/schema.js';
import type { Email } from '../src/mail/mailer.js';
import { createTestDatabase, databaseUrl } from './helpers/testDatabase.js';

const jwtSecret = 'test-secret-that-is-at-least-32-chars';

describe.skipIf(!databaseUrl)('forgot password', () => {
  let testDb: Awaited<ReturnType<typeof createTestDatabase>>;
  let app: App;
  // Mail is caught here instead of being sent.
  let inbox: Email[] = [];

  beforeAll(async () => {
    testDb = await createTestDatabase();
    app = buildApp({
      rateLimit: false,
      jwtSecret,
      database: testDb,
      sendMail: async (email) => {
        inbox.push(email);
      },
    });
    await app.ready();
  });
  beforeEach(() => {
    inbox = [];
  });
  afterAll(async () => {
    await app.close();
    await testDb.drop();
  });

  const post = (url: string, payload: object) => app.inject({ method: 'POST', url, payload });
  const register = (email: string, password = 'old password') =>
    post('/auth/register', { email, password });
  const requestCode = (email: string, language?: 'ru' | 'en') =>
    post('/auth/password-reset/request', { email, language });
  const confirm = (email: string, code: string, newPassword = 'brand new password') =>
    post('/auth/password-reset/confirm', { email, code, newPassword });
  /** The digits from the latest email, as a person would read them off. */
  const codeFromInbox = async () => {
    await new Promise((resolve) => setImmediate(resolve)); // mail is sent in the background
    return inbox.at(-1)!.text.match(/(\d{3}) (\d{3})/)!.slice(1).join('');
  };
  const wrongCode = (code: string) => (code === '000000' ? '111111' : '000000');

  it('email a code → new password → signed in, old password and devices out', async () => {
    const signedUp = await register('kate@example.com');

    expect((await requestCode('Kate@Example.com')).statusCode).toBe(202);
    const code = await codeFromInbox();
    expect(inbox.at(-1)!.to).toBe('kate@example.com');

    const reset = await confirm('kate@example.com', code);
    expect(reset.statusCode).toBe(200);
    expect(reset.json().accessToken).toEqual(expect.any(String));

    const login = (password: string) => post('/auth/login', { email: 'kate@example.com', password });
    expect((await login('brand new password')).statusCode).toBe(200);
    expect((await login('old password')).statusCode).toBe(401);
    // A device signed in before the reset is signed out.
    const oldDevice = await post('/auth/refresh', { refreshToken: signedUp.json().refreshToken });
    expect(oldDevice.statusCode).toBe(401);
  });

  it('the email speaks the app\'s language', async () => {
    await register('ru@example.com');

    await requestCode('ru@example.com', 'ru');
    await codeFromInbox();

    expect(inbox.at(-1)!.subject).toContain('Код для сброса пароля');
  });

  it('an unknown email gets the same answer, and no mail goes out', async () => {
    await register('known@example.com');

    const known = await requestCode('known@example.com');
    const unknown = await requestCode('nobody@example.com');

    expect(unknown.statusCode).toBe(known.statusCode);
    expect(unknown.json()).toEqual(known.json());
    expect(inbox.map((m) => m.to)).toEqual(['known@example.com']);
  });

  it('a code works once', async () => {
    await register('once@example.com');
    await requestCode('once@example.com');
    const code = await codeFromInbox();

    expect((await confirm('once@example.com', code)).statusCode).toBe(200);
    expect((await confirm('once@example.com', code)).statusCode).toBe(400);
  });

  it('five wrong guesses retire the code — even the right one stops working', async () => {
    await register('guess@example.com');
    await requestCode('guess@example.com');
    const code = await codeFromInbox();

    for (let i = 0; i < 5; i++) {
      const guess = await confirm('guess@example.com', wrongCode(code));
      expect(guess.json().error).toBe('invalid_code');
    }

    expect((await confirm('guess@example.com', code)).statusCode).toBe(400);
  });

  it('asking again within a minute sends nothing — the first code keeps working', async () => {
    await register('soon@example.com');
    await requestCode('soon@example.com');
    const code = await codeFromInbox();

    const again = await requestCode('soon@example.com');
    await new Promise((resolve) => setImmediate(resolve));

    expect(again.statusCode).toBe(202); // same answer as always
    expect(inbox).toHaveLength(1);
    expect((await confirm('soon@example.com', code)).statusCode).toBe(200);
  });

  it('asking again after the minute retires the previous code', async () => {
    const signedUp = await register('again@example.com');
    await requestCode('again@example.com');
    const first = await codeFromInbox();
    // Wind the clock past the one-minute wait.
    await testDb.db
      .update(passwordResets)
      .set({ createdAt: new Date(Date.now() - 2 * 60 * 1000) })
      .where(eq(passwordResets.userId, signedUp.json().user.id));
    await requestCode('again@example.com');
    const second = await codeFromInbox();
    expect(inbox).toHaveLength(2);

    if (first !== second) {
      expect((await confirm('again@example.com', first)).statusCode).toBe(400);
    }
    expect((await confirm('again@example.com', second)).statusCode).toBe(200);
  });

  it('an expired code is refused', async () => {
    const signedUp = await register('late@example.com');
    await requestCode('late@example.com');
    const code = await codeFromInbox();
    // Wind the clock: as if the email sat unread for 20 minutes.
    await testDb.db
      .update(passwordResets)
      .set({ expiresAt: new Date(Date.now() - 5 * 60 * 1000) })
      .where(eq(passwordResets.userId, signedUp.json().user.id));

    expect((await confirm('late@example.com', code)).statusCode).toBe(400);
  });

  it('stores the code\'s fingerprint, never the code', async () => {
    const signedUp = await register('fingerprint@example.com');
    await requestCode('fingerprint@example.com');
    const code = await codeFromInbox();

    const [row] = await testDb.db
      .select()
      .from(passwordResets)
      .where(eq(passwordResets.userId, signedUp.json().user.id));
    expect(row!.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(row!.tokenHash).not.toContain(code);
  });

  it('can give a password to an account that never had one', async () => {
    // As if it signed up with Google: no password at all.
    await testDb.db.insert(users).values({ email: 'nopass@example.com', googleId: 'g-1' });

    await requestCode('nopass@example.com');
    const reset = await confirm('nopass@example.com', await codeFromInbox());

    expect(reset.statusCode).toBe(200);
    expect(reset.json().user.hasPassword).toBe(true);
  });

  it('checks input: a code is exactly 6 digits, a new password at least 8 characters', async () => {
    expect((await confirm('kate@example.com', '12345')).statusCode).toBe(400);
    expect((await confirm('kate@example.com', '12345a')).statusCode).toBe(400);
    expect((await confirm('kate@example.com', '123456', 'short')).statusCode).toBe(400);
  });

  it('answers 503 when no mail server is set up', async () => {
    const withoutMail = buildApp({ rateLimit: false, jwtSecret, database: testDb });

    const response = await withoutMail.inject({
      method: 'POST',
      url: '/auth/password-reset/request',
      payload: { email: 'kate@example.com' },
    });

    expect(response.statusCode).toBe(503);
    await withoutMail.close();
  });
});
