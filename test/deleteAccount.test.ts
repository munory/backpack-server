import { randomUUID } from 'node:crypto';

import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp, type App } from '../src/app.js';
import {
  categories,
  deletions,
  items,
  passwordResets,
  refreshTokens,
  tripItems,
  trips,
  users,
} from '../src/db/schema.js';
import { createTestDatabase, databaseUrl } from './helpers/testDatabase.js';
import { createInbox, signUp } from './helpers/signUp.js';

const jwtSecret = 'test-secret-that-is-at-least-32-chars';

describe.skipIf(!databaseUrl)('deleting an account', () => {
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
  const register = async (email: string) => {
    const body = (await signUp(app, inbox, email)).json();
    return { userId: body.user.id as string, accessToken: body.accessToken, refreshToken: body.refreshToken };
  };
  const deleteMe = (accessToken: string | undefined, payload: object = {}) =>
    app.inject({
      method: 'DELETE',
      url: '/me',
      headers: accessToken ? { authorization: `Bearer ${accessToken}` } : {},
      payload,
    });

  /** Gives the account a bit of everything: synced data, a reset code. */
  const fillUp = async (userId: string, email: string) => {
    const now = Date.now();
    const [categoryUuid, itemUuid, tripUuid] = [randomUUID(), randomUUID(), randomUUID()];
    await testDb.db.insert(categories).values({ userId, uuid: categoryUuid, name: 'Кухня', packType: 1, updatedAt: now });
    await testDb.db.insert(items).values({ userId, uuid: itemUuid, name: 'Горелка', weightGrams: 80, categoryUuid, condition: 0, updatedAt: now });
    await testDb.db.insert(trips).values({ userId, uuid: tripUuid, name: 'Карелия', createdAtMs: now, updatedAt: now });
    await testDb.db.insert(tripItems).values({ userId, tripUuid, itemUuid, updatedAt: now });
    await testDb.db.insert(deletions).values({ userId, entity: 'items', entityKey: randomUUID(), deletedAt: now });
    await post('/auth/password-reset/request', { email });
  };

  /** How many rows of the user's are left in each table. */
  const leftovers = async (userId: string) => ({
    users: (await testDb.db.select().from(users).where(eq(users.id, userId))).length,
    refreshTokens: (await testDb.db.select().from(refreshTokens).where(eq(refreshTokens.userId, userId))).length,
    passwordResets: (await testDb.db.select().from(passwordResets).where(eq(passwordResets.userId, userId))).length,
    categories: (await testDb.db.select().from(categories).where(eq(categories.userId, userId))).length,
    items: (await testDb.db.select().from(items).where(eq(items.userId, userId))).length,
    trips: (await testDb.db.select().from(trips).where(eq(trips.userId, userId))).length,
    tripItems: (await testDb.db.select().from(tripItems).where(eq(tripItems.userId, userId))).length,
    deletions: (await testDb.db.select().from(deletions).where(eq(deletions.userId, userId))).length,
  });
  const nothing = {
    users: 0, refreshTokens: 0, passwordResets: 0, categories: 0,
    items: 0, trips: 0, tripItems: 0, deletions: 0,
  };

  it('removes the account and every row it owned', async () => {
    const kate = await register('kate@example.com');
    await fillUp(kate.userId, 'kate@example.com');
    expect(await leftovers(kate.userId)).not.toEqual(nothing);

    const response = await deleteMe(kate.accessToken, { password: 'my password' });

    expect(response.statusCode).toBe(204);
    expect(await leftovers(kate.userId)).toEqual(nothing);
  });

  it('afterwards nothing of the old account works, and the email is free again', async () => {
    const anna = await register('anna@example.com');
    await deleteMe(anna.accessToken, { password: 'my password' });

    expect((await app.inject({
      method: 'GET', url: '/me', headers: { authorization: `Bearer ${anna.accessToken}` },
    })).statusCode).toBe(401);
    expect((await post('/auth/refresh', { refreshToken: anna.refreshToken })).statusCode).toBe(401);
    expect((await post('/auth/login', { email: 'anna@example.com', password: 'my password' })).statusCode).toBe(401);

    const again = await signUp(app, inbox, 'anna@example.com', 'fresh start');
    expect(again.statusCode).toBe(201);
    expect(again.json().user.id).not.toBe(anna.userId);
  });

  it('a wrong or missing password keeps the account', async () => {
    const boris = await register('boris@example.com');

    expect((await deleteMe(boris.accessToken, { password: 'not it' })).statusCode).toBe(403);
    expect((await deleteMe(boris.accessToken)).json().error).toBe('wrong_password');
    expect((await leftovers(boris.userId)).users).toBe(1);
  });

  it('an account without a password is deleted on being signed in alone', async () => {
    const [noPassword] = await testDb.db
      .insert(users)
      .values({ email: 'google-only@example.com', googleId: 'g-1' })
      .returning();
    const accessToken = app.jwt.sign({ sub: noPassword!.id });

    expect((await deleteMe(accessToken)).statusCode).toBe(204);
    expect((await leftovers(noPassword!.id)).users).toBe(0);
  });

  it('without signing in → 401', async () => {
    expect((await deleteMe(undefined, { password: 'my password' })).statusCode).toBe(401);
  });

  it("someone else's account is untouched", async () => {
    const victor = await register('victor@example.com');
    await fillUp(victor.userId, 'victor@example.com');
    const dasha = await register('dasha@example.com');

    await deleteMe(dasha.accessToken, { password: 'my password' });

    expect((await leftovers(victor.userId)).items).toBe(1);
  });
});
