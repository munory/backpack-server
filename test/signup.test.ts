import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp, type App } from '../src/app.js';
import { pendingSignups, users } from '../src/db/schema.js';
import { createTestDatabase, databaseUrl } from './helpers/testDatabase.js';
import { createInbox, signUp } from './helpers/signUp.js';

const jwtSecret = 'test-secret-that-is-at-least-32-chars';

describe.skipIf(!databaseUrl)('sign-up with an emailed code', () => {
  let testDb: Awaited<ReturnType<typeof createTestDatabase>>;
  let app: App;
  const inbox = createInbox();

  beforeAll(async () => {
    testDb = await createTestDatabase();
    app = buildApp({ rateLimit: false, jwtSecret, database: testDb, sendMail: inbox.sendMail });
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
    await testDb.drop();
  });

  const post = (url: string, payload: object) => app.inject({ method: 'POST', url, payload });
  const start = (email: string, password = 'my password', language?: 'ru' | 'en') =>
    post('/auth/register', { email, password, language });
  const confirm = (email: string, code: string) => post('/auth/register/confirm', { email, code });
  const accountsWith = async (email: string) =>
    (await testDb.db.select().from(users).where(eq(users.email, email))).length;
  const wrong = (code: string) => (code === '000000' ? '111111' : '000000');

  it('no account until the emailed code is typed in', async () => {
    expect((await start('Kate@Example.com', 'my password', 'ru')).statusCode).toBe(202);
    expect(await accountsWith('kate@example.com')).toBe(0);

    const email = inbox.mail.at(-1)!;
    expect(email.to).toBe('kate@example.com');
    expect(email.subject).toMatch(/^Код для регистрации в Backpack: \d{3} \d{3}$/);

    const done = await confirm('kate@example.com', inbox.lastCodeFor('kate@example.com'));
    expect(done.statusCode).toBe(201);
    expect(done.json().user).toMatchObject({ email: 'kate@example.com', hasPassword: true });
    expect(done.json().accessToken).toEqual(expect.any(String));
    expect(await accountsWith('kate@example.com')).toBe(1);

    // The password chosen at the start is the one that works.
    expect((await post('/auth/login', { email: 'kate@example.com', password: 'my password' })).statusCode).toBe(200);
  });

  it('an email that already has an account is told so straight away', async () => {
    await signUp(app, inbox, 'anna@example.com');
    const sentBefore = inbox.mail.length;

    const again = await start('anna@example.com');

    expect(again.statusCode).toBe(409);
    expect(again.json().error).toBe('email_taken');
    expect(inbox.mail.length).toBe(sentBefore);
  });

  it('a wrong code creates nothing, and the fifth miss retires the code', async () => {
    await start('boris@example.com');
    const code = inbox.lastCodeFor('boris@example.com');

    for (let i = 0; i < 5; i++) {
      expect((await confirm('boris@example.com', wrong(code))).json().error).toBe('invalid_code');
    }
    expect((await confirm('boris@example.com', code)).statusCode).toBe(400);
    expect(await accountsWith('boris@example.com')).toBe(0);
  });

  it('an expired code does not work', async () => {
    await start('late@example.com');
    await testDb.db
      .update(pendingSignups)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(pendingSignups.email, 'late@example.com'));

    expect((await confirm('late@example.com', inbox.lastCodeFor('late@example.com'))).statusCode).toBe(400);
  });

  it('within a minute no second email — the first code still works, with the latest password', async () => {
    await start('soon@example.com', 'first password');
    const sent = inbox.mail.length;
    const code = inbox.lastCodeFor('soon@example.com');

    expect((await start('soon@example.com', 'second password')).statusCode).toBe(202);
    expect(inbox.mail.length).toBe(sent);

    expect((await confirm('soon@example.com', code)).statusCode).toBe(201);
    expect((await post('/auth/login', { email: 'soon@example.com', password: 'second password' })).statusCode).toBe(200);
  });

  it('after the minute a new code is sent, and only the new one works', async () => {
    await start('again@example.com');
    const oldCode = inbox.lastCodeFor('again@example.com');
    await testDb.db
      .update(pendingSignups)
      .set({ createdAt: new Date(Date.now() - 61_000) })
      .where(eq(pendingSignups.email, 'again@example.com'));

    await start('again@example.com');
    const newCode = inbox.lastCodeFor('again@example.com');

    if (oldCode !== newCode) expect((await confirm('again@example.com', oldCode)).statusCode).toBe(400);
    expect((await confirm('again@example.com', newCode)).statusCode).toBe(201);
  });

  it('the code works once', async () => {
    await start('once@example.com');
    const code = inbox.lastCodeFor('once@example.com');

    expect((await confirm('once@example.com', code)).statusCode).toBe(201);
    expect((await confirm('once@example.com', code)).statusCode).toBe(400);
    expect(await accountsWith('once@example.com')).toBe(1);
  });

  it('a code for one email does not create another', async () => {
    await start('vera@example.com');
    await start('vlad@example.com');

    expect((await confirm('vlad@example.com', inbox.lastCodeFor('vera@example.com'))).statusCode).toBe(
      inbox.lastCodeFor('vera@example.com') === inbox.lastCodeFor('vlad@example.com') ? 201 : 400,
    );
    expect(await accountsWith('vera@example.com')).toBe(0);
  });

  it('a bad email or short password is refused before any email', async () => {
    const sent = inbox.mail.length;
    expect((await start('not-an-email')).statusCode).toBe(400);
    expect((await start('ok@example.com', 'short')).statusCode).toBe(400);
    expect(inbox.mail.length).toBe(sent);
  });

  it('without a mail server sign-up is off (503)', async () => {
    const withoutMail = buildApp({ rateLimit: false, jwtSecret, database: testDb });
    const response = await withoutMail.inject({
      method: 'POST', url: '/auth/register', payload: { email: 'x@example.com', password: 'my password' },
    });
    expect(response.statusCode).toBe(503);
    expect(response.json().error).toBe('mail_not_configured');
    await withoutMail.close();
  });

  it('if the email cannot be sent, the person hears so', async () => {
    const brokenMail = buildApp({
      rateLimit: false, jwtSecret, database: testDb,
      sendMail: async () => {
        throw new Error('SMTP is down');
      },
    });
    const response = await brokenMail.inject({
      method: 'POST', url: '/auth/register', payload: { email: 'y@example.com', password: 'my password' },
    });
    expect(response.statusCode).toBe(503);
    expect(response.json().error).toBe('mail_failed');
    await brokenMail.close();
  });

  describe('the name, set any time from Profile', () => {
    const patchMe = (token: string, payload: object) =>
      app.inject({ method: 'PATCH', url: '/me', headers: { authorization: `Bearer ${token}` }, payload });

    it('starts empty, can be set, changed and cleared', async () => {
      const signedUp = (await signUp(app, inbox, 'lena@example.com')).json();
      expect(signedUp.user.name).toBeNull();

      const named = await patchMe(signedUp.accessToken, { name: '  Лена ' });
      expect(named.statusCode).toBe(200);
      expect(named.json().name).toBe('Лена');

      expect((await patchMe(signedUp.accessToken, { name: '' })).json().name).toBeNull();
      expect((await patchMe(signedUp.accessToken, { name: null })).json().name).toBeNull();
    });

    it('nothing else can be changed this way', async () => {
      const signedUp = (await signUp(app, inbox, 'max@example.com')).json();

      const response = await patchMe(signedUp.accessToken, { name: 'Макс', email: 'other@example.com' });

      expect(response.json()).toMatchObject({ name: 'Макс', email: 'max@example.com' });
    });

    it('too long a name → 400; signed out → 401', async () => {
      const signedUp = (await signUp(app, inbox, 'nina@example.com')).json();
      expect((await patchMe(signedUp.accessToken, { name: 'я'.repeat(101) })).statusCode).toBe(400);
      expect((await app.inject({ method: 'PATCH', url: '/me', payload: { name: 'x' } })).statusCode).toBe(401);
    });
  });
});
