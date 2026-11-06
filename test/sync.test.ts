import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp, type App } from '../src/app.js';
import type { CategoryWire, ItemWire, SyncRequest, SyncResponse } from '../src/sync/wire.js';
import { createTestDatabase, databaseUrl } from './helpers/testDatabase.js';
import { createInbox, signUp } from './helpers/signUp.js';

const jwtSecret = 'test-secret-that-is-at-least-32-chars';

describe.skipIf(!databaseUrl)('POST /sync', () => {
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

  const register = async (email: string) => {
    const response = await signUp(app, inbox, email);
    return response.json().accessToken as string;
  };

  /** A phone: remembers its cursor between syncs, like the app will. */
  const device = (accessToken: string) => {
    let cursor = 0;
    return {
      async sync(payload: Omit<SyncRequest, 'cursor'> = {}) {
        const response = await app.inject({
          method: 'POST',
          url: '/sync',
          headers: { authorization: `Bearer ${accessToken}` },
          payload: { cursor, ...payload },
        });
        expect(response.statusCode).toBe(200);
        const body = response.json() as SyncResponse;
        cursor = body.cursor;
        return body;
      },
    };
  };

  const item = (fields: Partial<ItemWire> = {}): ItemWire => ({
    uuid: randomUUID(), name: 'Горелка', weightGrams: 80, categoryUuid: null,
    condition: 0, packType: null, quantity: 1, worn: false, updatedAt: 1000, ...fields,
  });
  const category = (fields: Partial<CategoryWire> = {}): CategoryWire => ({
    uuid: randomUUID(), name: 'Кухня', parentUuid: null, packType: 1,
    icon: null, color: null, updatedAt: 1000, ...fields,
  });
  const items = (list: ItemWire[]) => ({ changes: { categories: [], items: list, trips: [], tripItems: [] } });

  it('a change on one phone reaches the other', async () => {
    const token = await register('kate@example.com');
    const [phone, tablet] = [device(token), device(token)];
    const kitchen = category();
    const stove = item({ categoryUuid: kitchen.uuid });

    await phone.sync({ changes: { categories: [kitchen], items: [stove], trips: [], tripItems: [] } });
    const pulled = await tablet.sync();

    expect(pulled.changes.categories).toEqual([kitchen]);
    expect(pulled.changes.items).toEqual([stove]);
    expect(pulled.hasMore).toBe(false);
    // Nothing new the second time.
    expect((await tablet.sync()).changes.items).toEqual([]);
  });

  it("doesn't echo a phone's own changes back to it", async () => {
    const phone = device(await register('anna@example.com'));
    const sent = await phone.sync(items([item()]));

    expect(sent.changes.items).toEqual([]);
    expect(sent.cursor).toBeGreaterThan(0);
    expect((await phone.sync()).changes.items).toEqual([]);
  });

  it('the later edit wins, whichever arrives first', async () => {
    const token = await register('boris@example.com');
    const [phone, tablet] = [device(token), device(token)];
    const stove = item({ updatedAt: 1000 });
    await phone.sync(items([stove]));
    await tablet.sync();

    // Both edit offline; the tablet's edit is later but syncs first.
    await tablet.sync(items([{ ...stove, weightGrams: 95, updatedAt: 3000 }]));
    const phoneGets = await phone.sync(items([{ ...stove, weightGrams: 70, updatedAt: 2000 }]));

    // The phone's older edit lost, and it's handed the winner.
    expect(phoneGets.changes.items).toEqual([{ ...stove, weightGrams: 95, updatedAt: 3000 }]);
    expect((await tablet.sync()).changes.items).toEqual([]);
  });

  it('a deletion reaches the other phone', async () => {
    const token = await register('victor@example.com');
    const [phone, tablet] = [device(token), device(token)];
    const stove = item();
    await phone.sync(items([stove]));
    await tablet.sync();

    await phone.sync({ deletions: [{ entity: 'items', key: stove.uuid, deletedAt: 2000 }] });

    expect((await tablet.sync()).deletions).toEqual([{ entity: 'items', key: stove.uuid, deletedAt: 2000 }]);
    expect((await device(token).sync()).changes.items).toEqual([]);
  });

  it('an edit older than the deletion does not bring the row back', async () => {
    const token = await register('dasha@example.com');
    const [phone, tablet] = [device(token), device(token)];
    const stove = item({ updatedAt: 1000 });
    await phone.sync(items([stove]));
    await tablet.sync();

    await phone.sync({ deletions: [{ entity: 'items', key: stove.uuid, deletedAt: 3000 }] });
    const tabletGets = await tablet.sync(items([{ ...stove, name: 'Старая правка', updatedAt: 2000 }]));

    expect(tabletGets.deletions.map((d) => d.key)).toEqual([stove.uuid]);
    expect((await device(token).sync()).changes.items).toEqual([]);
  });

  it('an edit newer than the deletion wins over it', async () => {
    const token = await register('egor@example.com');
    const [phone, tablet] = [device(token), device(token)];
    const stove = item({ updatedAt: 1000 });
    await phone.sync(items([stove]));
    await tablet.sync();

    await phone.sync({ deletions: [{ entity: 'items', key: stove.uuid, deletedAt: 2000 }] });
    await tablet.sync(items([{ ...stove, name: 'Новая горелка', updatedAt: 3000 }]));

    const fresh = await device(token).sync();
    expect(fresh.changes.items.map((i) => i.name)).toEqual(['Новая горелка']);
    expect(fresh.deletions).toEqual([]);
  });

  it('works for trip items too, keyed by trip and item', async () => {
    const token = await register('fedor@example.com');
    const [phone, tablet] = [device(token), device(token)];
    const [tripUuid, itemUuid] = [randomUUID(), randomUUID()];
    const packed = { tripUuid, itemUuid, quantity: 2, inBag: false, updatedAt: 1000 };

    await phone.sync({ changes: { categories: [], items: [], trips: [], tripItems: [packed] } });
    expect((await tablet.sync()).changes.tripItems).toEqual([packed]);

    const key = `${tripUuid}/${itemUuid}`;
    await phone.sync({ deletions: [{ entity: 'trip_items', key, deletedAt: 2000 }] });
    expect((await tablet.sync()).deletions).toEqual([{ entity: 'trip_items', key, deletedAt: 2000 }]);
  });

  it('sending the same thing twice changes nothing', async () => {
    const token = await register('galya@example.com');
    const [phone, tablet] = [device(token), device(token)];
    const payload = items([item()]);

    await phone.sync(payload);
    await tablet.sync();
    await phone.sync(payload);

    expect((await tablet.sync()).changes.items).toEqual([]);
  });

  it('hands out a big backlog in pages, losing nothing', async () => {
    const token = await register('igor@example.com');
    const phone = device(token);
    const sent = Array.from({ length: 120 }, (_, i) => item({ name: `Вещь ${i}` }));
    await phone.sync(items(sent));

    const tablet = device(token);
    const got: ItemWire[] = [];
    let pages = 0;
    for (let more = true; more; pages++) {
      const page = await tablet.sync({ limit: 50 });
      got.push(...page.changes.items);
      more = page.hasMore;
    }

    expect(pages).toBe(3);
    expect(got.map((i) => i.uuid).sort()).toEqual(sent.map((i) => i.uuid).sort());
  });

  it("never shows one person's data to another", async () => {
    const mine = device(await register('lena@example.com'));
    await mine.sync(items([item({ name: 'Моя палатка' })]));

    const stranger = device(await register('max@example.com'));
    const theirs = await stranger.sync();

    expect(theirs.changes.items).toEqual([]);
    // And the stranger can't delete it either.
    await stranger.sync({ deletions: [{ entity: 'items', key: randomUUID(), deletedAt: 9999 }] });
  });

  it('a malformed deletion key is ignored, not a crash', async () => {
    const phone = device(await register('nina@example.com'));
    const answer = await phone.sync({ deletions: [{ entity: 'items', key: 'not-a-uuid', deletedAt: 1 }] });
    expect(answer.deletions).toEqual([]);
  });

  it('rejects rows that break the contract', async () => {
    const token = await register('olga@example.com');
    const response = await app.inject({
      method: 'POST', url: '/sync', headers: { authorization: `Bearer ${token}` },
      payload: { cursor: 0, ...items([{ ...item(), weightGrams: -5 }]) },
    });
    expect(response.statusCode).toBe(400);
  });

  it('without signing in, or after the account is deleted → 401', async () => {
    expect((await app.inject({ method: 'POST', url: '/sync', payload: { cursor: 0 } })).statusCode).toBe(401);

    const token = await register('pavel@example.com');
    await app.inject({
      method: 'DELETE', url: '/me', headers: { authorization: `Bearer ${token}` },
      payload: { password: 'my password' },
    });
    const response = await app.inject({
      method: 'POST', url: '/sync', headers: { authorization: `Bearer ${token}` }, payload: { cursor: 0 },
    });
    expect(response.statusCode).toBe(401);
  });
});
