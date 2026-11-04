import { randomUUID } from 'node:crypto';

import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { Db } from '../src/db/client.js';
import { items, refreshTokens, users } from '../src/db/schema.js';
import { createTestDatabase, databaseUrl } from './helpers/testDatabase.js';

// Applies the migrations to a brand-new throwaway database — never the
// working one — then checks the rules the database itself enforces.
describe.skipIf(!databaseUrl)('database schema', () => {
  let testDb: Awaited<ReturnType<typeof createTestDatabase>>;
  let db: Db;

  beforeAll(async () => {
    testDb = await createTestDatabase();
    db = testDb.db;
  });
  afterAll(async () => testDb.drop());

  const addUser = async (email: string) =>
    (await db.insert(users).values({ email }).returning())[0]!;

  const itemFor = (userId: string, uuid = randomUUID()) => ({
    userId,
    uuid,
    name: 'Горелка',
    weightGrams: 80,
    condition: 0,
    updatedAt: Date.now(),
  });

  it('allows one account per email', async () => {
    await addUser('kate@example.com');

    await expect(addUser('kate@example.com')).rejects.toMatchObject({
      cause: { code: '23505' }, // unique_violation
    });
  });

  it('deleting a user deletes all their data with them', async () => {
    const user = await addUser('cascade@example.com');
    await db.insert(items).values(itemFor(user.id));
    await db.insert(refreshTokens).values({
      userId: user.id,
      tokenHash: 'hash',
      expiresAt: new Date(Date.now() + 60_000),
    });

    await db.delete(users).where(eq(users.id, user.id));

    expect(await db.select().from(items).where(eq(items.userId, user.id))).toEqual([]);
    expect(
      await db.select().from(refreshTokens).where(eq(refreshTokens.userId, user.id)),
    ).toEqual([]);
  });

  it('numbers changes in the order the server saw them', async () => {
    const user = await addUser('seq@example.com');
    const [first] = await db.insert(items).values(itemFor(user.id)).returning();
    const [second] = await db.insert(items).values(itemFor(user.id)).returning();

    expect(second!.serverSeq).toBeGreaterThan(first!.serverSeq);
  });

  it('a uuid is unique per user, not across users', async () => {
    const kate = await addUser('a@example.com');
    const anna = await addUser('b@example.com');
    const shared = randomUUID();

    await db.insert(items).values(itemFor(kate.id, shared));
    await db.insert(items).values(itemFor(anna.id, shared));
    await expect(db.insert(items).values(itemFor(kate.id, shared))).rejects.toMatchObject({
      cause: { code: '23505' },
    });
  });
});
