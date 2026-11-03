import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';

import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { items, refreshTokens, users } from '../src/db/schema.js';

// Applies the migrations to a brand-new throwaway database — never the
// working one — then checks the rules the database itself enforces.
if (existsSync('.env')) process.loadEnvFile('.env');
const url = process.env.DATABASE_URL;

describe.skipIf(!url)('database schema', () => {
  const name = `backpack_test_${Date.now()}`;
  const admin = postgres(url!, { max: 1 });
  const testUrl = new URL(url!);
  testUrl.pathname = `/${name}`;
  const client = postgres(testUrl.toString(), { max: 1, onnotice: () => {} });
  const db = drizzle(client);

  beforeAll(async () => {
    await admin.unsafe(`CREATE DATABASE ${name}`);
    await migrate(db, { migrationsFolder: 'drizzle' });
  });

  afterAll(async () => {
    await client.end();
    await admin.unsafe(`DROP DATABASE ${name}`);
    await admin.end();
  });

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
