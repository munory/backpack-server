import { and, eq, getTableColumns, gt, inArray, type SQL, sql } from 'drizzle-orm';
import type { PgTable, PgUpdateSetSource } from 'drizzle-orm/pg-core';

import type { Db } from '../db/client.js';
import { categories, deletions, items, tripItems, trips } from '../db/schema.js';
import type {
  Changes,
  DeletionWire,
  Entity,
  SyncRequest,
  SyncResponse,
} from './wire.js';

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

export const DEFAULT_PAGE_SIZE = 500;

/**
 * One round of sync for one user: apply what the device sends, then hand back
 * everything that changed on the server since the device's cursor.
 *
 * Rules:
 * - Conflicts: per row, the later `updatedAt` wins. An older edit arriving
 *   late is ignored — and the device gets the newer version back.
 * - A deletion and an edit: the later one wins too. A deletion leaves a
 *   tombstone in `deletions`, so devices that still have the row learn to
 *   drop it, and an older edit can't bring it back.
 * - Resending the same thing is harmless (idempotent): equal timestamps
 *   change nothing.
 */
export async function sync(db: Db, userId: string, request: SyncRequest): Promise<SyncResponse> {
  const changes: Changes = {
    categories: [],
    items: [],
    trips: [],
    tripItems: [],
    ...request.changes,
  };
  const limit = request.limit ?? DEFAULT_PAGE_SIZE;

  return db.transaction(async (tx) => {
    // One sync at a time per user. Changes are numbered by a shared counter
    // (server_seq) and devices fetch "everything after number N" — but
    // numbers are handed out when a write starts, not when it's saved. If two
    // of the user's devices synced at once, the later number could be saved
    // first, a device could move its cursor past it, and the earlier number,
    // saved a moment after, would never be fetched. Taking turns per user
    // rules that out; different users still sync in parallel.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${userId}, 0))`);

    // What this device sent, so it isn't echoed straight back to it.
    const sent = new Set<string>();

    await upsertNewer(tx, userId, 'categories', categories, [categories.uuid], changes.categories, (r) => r.uuid, sent);
    await upsertNewer(tx, userId, 'items', items, [items.uuid], changes.items, (r) => r.uuid, sent);
    await upsertNewer(tx, userId, 'trips', trips, [trips.uuid], changes.trips, (r) => r.uuid, sent);
    await upsertNewer(
      tx, userId, 'trip_items', tripItems, [tripItems.tripUuid, tripItems.itemUuid],
      changes.tripItems, (r) => `${r.tripUuid}/${r.itemUuid}`, sent,
    );
    await applyDeletions(tx, userId, request.deletions ?? [], sent);

    return pull(tx, userId, request.cursor, limit, sent);
  });
}

// ---------------------------------------------------------------------------
// Push: rows the device changed
// ---------------------------------------------------------------------------

/** Keeps only the newest version of each row, in case one arrives twice. */
function newestByKey<T>(rows: T[], key: (row: T) => string, time: (row: T) => number): T[] {
  const newest = new Map<string, T>();
  for (const row of rows) {
    const current = newest.get(key(row));
    if (!current || time(row) > time(current)) newest.set(key(row), row);
  }
  return [...newest.values()];
}

/** SET every non-key column from the incoming row ("excluded" is Postgres's
 * name for it) and give the row a new number. */
function takeIncoming<T extends PgTable>(table: T, skip: string[]): PgUpdateSetSource<T> {
  const set: Record<string, SQL> = {};
  for (const [property, column] of Object.entries(getTableColumns(table))) {
    if (skip.includes(property)) continue;
    set[property] = sql.raw(`excluded."${column.name}"`);
  }
  set.serverSeq = sql`nextval('sync_seq')`;
  return set as PgUpdateSetSource<T>;
}

async function upsertNewer<Row extends { updatedAt: number }>(
  tx: Tx,
  userId: string,
  entity: Entity,
  table: typeof categories | typeof items | typeof trips | typeof tripItems,
  keyColumns: Parameters<typeof inArray>[0][],
  incoming: Row[],
  key: (row: Row) => string,
  sent: Set<string>,
): Promise<void> {
  let rows = newestByKey(incoming, key, (r) => r.updatedAt);
  rows = await dropDeletedLater(tx, userId, entity, rows, key);
  if (rows.length === 0) return;
  for (const row of rows) sent.add(`${entity}:${key(row)}:${row.updatedAt}`);

  const skip = ['userId', 'serverSeq', ...Object.entries(getTableColumns(table))
    .filter(([, column]) => keyColumns.includes(column))
    .map(([property]) => property)];

  // "Insert, or — if the user already has this row — update it, but only
  // when ours is older." One statement for the whole batch: a new row is
  // added, a newer edit overwrites, an older or identical one is ignored.
  await tx
    .insert(table)
    .values(rows.map((row) => ({ ...row, userId })) as never)
    .onConflictDoUpdate({
      target: [table.userId, ...keyColumns] as never,
      set: takeIncoming(table, skip) as never,
      setWhere: sql`${table.updatedAt} < excluded.updated_at`,
    });
}

/**
 * Drops incoming rows deleted later than they were edited. A row edited after
 * its deletion comes back to life — and its tombstone goes.
 */
async function dropDeletedLater<Row extends { updatedAt: number }>(
  tx: Tx,
  userId: string,
  entity: Entity,
  rows: Row[],
  key: (row: Row) => string,
): Promise<Row[]> {
  if (rows.length === 0) return rows;
  const tombstones = await tx
    .select({ key: deletions.entityKey, deletedAt: deletions.deletedAt })
    .from(deletions)
    .where(and(
      eq(deletions.userId, userId),
      eq(deletions.entity, entity),
      inArray(deletions.entityKey, rows.map(key)),
    ));
  const deletedAt = new Map(tombstones.map((t) => [t.key, t.deletedAt]));

  const alive = rows.filter((row) => {
    const at = deletedAt.get(key(row));
    return at === undefined || row.updatedAt > at;
  });
  const revived = alive.map(key).filter((k) => deletedAt.has(k));
  if (revived.length > 0) {
    await tx.delete(deletions).where(and(
      eq(deletions.userId, userId),
      eq(deletions.entity, entity),
      inArray(deletions.entityKey, revived),
    ));
  }
  return alive;
}

// ---------------------------------------------------------------------------
// Push: rows the device deleted
// ---------------------------------------------------------------------------

/** The table and how to find a row in it by its deletion key. */
function locate(entity: Entity, userId: string, keys: string[]) {
  switch (entity) {
    case 'categories':
      return { table: categories, where: and(eq(categories.userId, userId), inArray(categories.uuid, keys))! };
    case 'items':
      return { table: items, where: and(eq(items.userId, userId), inArray(items.uuid, keys))! };
    case 'trips':
      return { table: trips, where: and(eq(trips.userId, userId), inArray(trips.uuid, keys))! };
    case 'trip_items':
      return {
        table: tripItems,
        where: and(
          eq(tripItems.userId, userId),
          inArray(sql`${tripItems.tripUuid}::text || '/' || ${tripItems.itemUuid}::text`, keys),
        )!,
      };
  }
}

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const UUID_KEY = new RegExp(`^${UUID}$`);
const PAIR_KEY = new RegExp(`^${UUID}/${UUID}$`);

const keyOf = (entity: Entity) =>
  entity === 'trip_items'
    ? sql<string>`${tripItems.tripUuid}::text || '/' || ${tripItems.itemUuid}::text`
    : sql<string>`uuid::text`;

async function applyDeletions(
  tx: Tx,
  userId: string,
  incoming: DeletionWire[],
  sent: Set<string>,
): Promise<void> {
  const byEntity = new Map<Entity, DeletionWire[]>();
  for (const raw of incoming) {
    const d = { ...raw, key: raw.key.toLowerCase() };
    // A key that can't name a row of that kind can't delete anything; it's
    // skipped rather than letting Postgres choke on a malformed uuid.
    if (!(d.entity === 'trip_items' ? PAIR_KEY : UUID_KEY).test(d.key)) continue;
    byEntity.set(d.entity, [...(byEntity.get(d.entity) ?? []), d]);
  }

  for (const [entity, list] of byEntity) {
    const newest = newestByKey(list, (d) => d.key, (d) => d.deletedAt);
    const { table, where } = locate(entity, userId, newest.map((d) => d.key));

    // A deletion older than the row's last edit loses: someone changed the
    // row after it was deleted elsewhere, so it stays.
    const existing = await tx
      .select({ key: keyOf(entity), updatedAt: table.updatedAt })
      .from(table)
      .where(where);
    const editedAt = new Map(existing.map((r) => [r.key, r.updatedAt]));
    const winning = newest.filter((d) => !((editedAt.get(d.key) ?? -1) > d.deletedAt));
    if (winning.length === 0) continue;
    for (const d of winning) sent.add(`deleted:${entity}:${d.key}:${d.deletedAt}`);

    await tx.delete(table).where(locate(entity, userId, winning.map((d) => d.key)).where);
    // The tombstone — kept even for rows the server never had, since
    // another device may still have them.
    await tx
      .insert(deletions)
      .values(winning.map((d) => ({ userId, entity, entityKey: d.key, deletedAt: d.deletedAt })))
      .onConflictDoUpdate({
        target: [deletions.userId, deletions.entity, deletions.entityKey],
        set: { deletedAt: sql`excluded.deleted_at`, serverSeq: sql`nextval('sync_seq')` },
        setWhere: sql`${deletions.deletedAt} < excluded.deleted_at`,
      });
  }
}

// ---------------------------------------------------------------------------
// Pull: everything that changed since the device's cursor
// ---------------------------------------------------------------------------

async function pull(
  tx: Tx,
  userId: string,
  cursor: number,
  limit: number,
  sent: Set<string>,
): Promise<SyncResponse> {
  // Up to limit+1 from each table, in order: whatever the first `limit`
  // changes across all tables are, they're among these.
  const after = <T extends typeof categories | typeof items | typeof trips | typeof tripItems | typeof deletions>(table: T) =>
    and(eq(table.userId, userId), gt(table.serverSeq, cursor));
  const [cats, its, trs, tis, dels] = [
    await tx.select().from(categories).where(after(categories)).orderBy(categories.serverSeq).limit(limit + 1),
    await tx.select().from(items).where(after(items)).orderBy(items.serverSeq).limit(limit + 1),
    await tx.select().from(trips).where(after(trips)).orderBy(trips.serverSeq).limit(limit + 1),
    await tx.select().from(tripItems).where(after(tripItems)).orderBy(tripItems.serverSeq).limit(limit + 1),
    await tx.select().from(deletions).where(after(deletions)).orderBy(deletions.serverSeq).limit(limit + 1),
  ];

  type Entry =
    | { seq: number; kind: 'categories'; row: (typeof cats)[number] }
    | { seq: number; kind: 'items'; row: (typeof its)[number] }
    | { seq: number; kind: 'trips'; row: (typeof trs)[number] }
    | { seq: number; kind: 'trip_items'; row: (typeof tis)[number] }
    | { seq: number; kind: 'deleted'; row: (typeof dels)[number] };
  const all: Entry[] = [
    ...cats.map((row) => ({ seq: row.serverSeq, kind: 'categories' as const, row })),
    ...its.map((row) => ({ seq: row.serverSeq, kind: 'items' as const, row })),
    ...trs.map((row) => ({ seq: row.serverSeq, kind: 'trips' as const, row })),
    ...tis.map((row) => ({ seq: row.serverSeq, kind: 'trip_items' as const, row })),
    ...dels.map((row) => ({ seq: row.serverSeq, kind: 'deleted' as const, row })),
  ].sort((a, b) => a.seq - b.seq);
  const page = all.slice(0, limit);

  const response: SyncResponse = {
    // Past this device's own writes too — they're simply not sent back.
    cursor: page.at(-1)?.seq ?? cursor,
    hasMore: all.length > limit,
    changes: { categories: [], items: [], trips: [], tripItems: [] },
    deletions: [],
  };
  for (const entry of page) {
    switch (entry.kind) {
      case 'categories': {
        const { userId: _u, serverSeq: _s, ...row } = entry.row;
        if (!sent.has(`categories:${row.uuid}:${row.updatedAt}`)) response.changes.categories.push(row);
        break;
      }
      case 'items': {
        const { userId: _u, serverSeq: _s, ...row } = entry.row;
        if (!sent.has(`items:${row.uuid}:${row.updatedAt}`)) response.changes.items.push(row);
        break;
      }
      case 'trips': {
        const { userId: _u, serverSeq: _s, ...row } = entry.row;
        if (!sent.has(`trips:${row.uuid}:${row.updatedAt}`)) response.changes.trips.push(row);
        break;
      }
      case 'trip_items': {
        const { userId: _u, serverSeq: _s, ...row } = entry.row;
        if (!sent.has(`trip_items:${row.tripUuid}/${row.itemUuid}:${row.updatedAt}`)) {
          response.changes.tripItems.push(row);
        }
        break;
      }
      case 'deleted': {
        const { entity, entityKey, deletedAt } = entry.row;
        if (!sent.has(`deleted:${entity}:${entityKey}:${deletedAt}`)) {
          response.deletions.push({ entity: entity as Entity, key: entityKey, deletedAt });
        }
        break;
      }
    }
  }
  return response;
}
