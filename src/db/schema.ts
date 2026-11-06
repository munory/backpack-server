import {
  bigint,
  boolean,
  index,
  integer,
  pgSequence,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------

/**
 * A person with an account. Signs in with email + password, with Google, or
 * both — the same email is the same account.
 */
export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  /** Always stored lowercased, so "Kate@Mail.ru" and "kate@mail.ru" match. */
  email: text('email').notNull().unique(),
  /** argon2 hash of the password — never the password itself. Null for an
   * account that only ever signed in with Google. */
  passwordHash: text('password_hash'),
  /** Google's stable id for the person ("sub"); null until they use Google. */
  googleId: text('google_id').unique(),
  name: text('name'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Long-lived "renew my pass" tokens handed to signed-in devices. Only a hash
 * is stored: a leaked database can't be used to sign in as anyone.
 * Rotated on every use — a used token is revoked and replaced.
 */
export const refreshTokens = pgTable(
  'refresh_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull().unique(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('refresh_tokens_user_idx').on(t.userId)],
);

/**
 * "Forgot password" codes — 6 digits sent by email, valid 15 minutes, 5 tries.
 * A new request retires the previous code (marks it used).
 */
export const passwordResets = pgTable(
  'password_resets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** HMAC of the code with the server's secret — never the code itself. Not
     * unique: two people can be sent the same 6 digits. */
    tokenHash: text('token_hash').notNull(),
    /** Wrong codes typed so far; at 5 the code is retired. */
    attempts: integer('attempts').notNull().default(0),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    usedAt: timestamp('used_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('password_resets_user_idx').on(t.userId)],
);

/**
 * Sign-ups waiting for their email to be confirmed. The account itself is
 * created only once the 6-digit code from the email is typed in — so an
 * address with a typo, or someone else's, never becomes an account. Same
 * rules as reset codes: 15 minutes, 5 tries, a new request retires the old.
 * Not linked to users: there is no user yet.
 */
export const pendingSignups = pgTable(
  'pending_signups',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    email: text('email').notNull(),
    /** The chosen password, already hashed — kept until the account exists. */
    passwordHash: text('password_hash').notNull(),
    /** HMAC of the code, as for reset codes. */
    codeHash: text('code_hash').notNull(),
    attempts: integer('attempts').notNull().default(0),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    usedAt: timestamp('used_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('pending_signups_email_idx').on(t.email)],
);

// ---------------------------------------------------------------------------
// Synced data — the cloud copy of what lives in the app's SQLite
// ---------------------------------------------------------------------------
//
// Every row belongs to a user and is identified by the app's own uuid (the
// same on all of that user's devices), so the primary key is (user, uuid).
//
// References between these tables (item → category, category → parent,
// trip item → trip and item) are plain uuids, deliberately NOT foreign keys:
// a phone can sync an item before its category arrives, and a foreign key
// would reject it. Only `user_id` is a real foreign key — deleting a user
// deletes all their data with it (ON DELETE CASCADE).
//
// Two clocks per row:
// - `updated_at` — when it was changed on the device, in ms since the epoch.
//   Decides conflicts: the later edit wins.
// - `server_seq` — the order the server saw changes in, from one shared
//   counter. A device asks "everything after number N" — sturdier than
//   asking by time, since phone clocks can be off.
//
// Enums are stored as the app's enum index (lib/data/database.dart):
// pack_type: 0 food, 1 gear, 2 water;
// condition: 0 newItem, 1 needsReplacement, 2 wornOut.

/** The one counter every synced change takes its `server_seq` from. */
export const syncSeq = pgSequence('sync_seq');

const userId = () =>
  uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' });
const updatedAt = () => bigint('updated_at', { mode: 'number' }).notNull();
const serverSeq = () =>
  bigint('server_seq', { mode: 'number' })
    .notNull()
    .default(sql`nextval('sync_seq')`);

export const categories = pgTable(
  'categories',
  {
    userId: userId(),
    uuid: uuid('uuid').notNull(),
    name: text('name').notNull(),
    parentUuid: uuid('parent_uuid'),
    packType: smallint('pack_type').notNull(),
    icon: text('icon'),
    color: text('color'),
    updatedAt: updatedAt(),
    serverSeq: serverSeq(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.uuid] }),
    index('categories_changes_idx').on(t.userId, t.serverSeq),
  ],
);

export const items = pgTable(
  'items',
  {
    userId: userId(),
    uuid: uuid('uuid').notNull(),
    name: text('name').notNull(),
    /** Weight of ONE, in whole grams — quantity is separate. */
    weightGrams: integer('weight_grams').notNull(),
    categoryUuid: uuid('category_uuid'),
    condition: smallint('condition').notNull(),
    /** Only meaningful when there's no category. */
    packType: smallint('pack_type'),
    quantity: integer('quantity').notNull().default(1),
    worn: boolean('worn').notNull().default(false),
    updatedAt: updatedAt(),
    serverSeq: serverSeq(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.uuid] }),
    index('items_changes_idx').on(t.userId, t.serverSeq),
  ],
);

export const trips = pgTable(
  'trips',
  {
    userId: userId(),
    uuid: uuid('uuid').notNull(),
    name: text('name').notNull(),
    targetWeightGrams: integer('target_weight_grams'),
    /** When the trip was created on the device, ms since the epoch. */
    createdAtMs: bigint('created_at_ms', { mode: 'number' }).notNull(),
    startDate: bigint('start_date', { mode: 'number' }),
    endDate: bigint('end_date', { mode: 'number' }),
    isDraft: boolean('is_draft').notNull().default(false),
    updatedAt: updatedAt(),
    serverSeq: serverSeq(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.uuid] }),
    index('trips_changes_idx').on(t.userId, t.serverSeq),
  ],
);

/** An item on a trip's list: identified by the trip and the item together. */
export const tripItems = pgTable(
  'trip_items',
  {
    userId: userId(),
    tripUuid: uuid('trip_uuid').notNull(),
    itemUuid: uuid('item_uuid').notNull(),
    /** How many of the owned units go on this trip; null = all of them. */
    quantity: integer('quantity'),
    inBag: boolean('in_bag').notNull().default(false),
    updatedAt: updatedAt(),
    serverSeq: serverSeq(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.tripUuid, t.itemUuid] }),
    index('trip_items_changes_idx').on(t.userId, t.serverSeq),
  ],
);

/**
 * Rows a device deleted, so the user's other devices delete them too instead
 * of bringing them back. Same keys as the app's sync_deletions: the row's
 * uuid, or "tripUuid/itemUuid" for a trip item.
 */
export const deletions = pgTable(
  'deletions',
  {
    userId: userId(),
    /** categories | items | trips | trip_items */
    entity: text('entity').notNull(),
    entityKey: text('entity_key').notNull(),
    deletedAt: bigint('deleted_at', { mode: 'number' }).notNull(),
    serverSeq: serverSeq(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.entity, t.entityKey] }),
    index('deletions_changes_idx').on(t.userId, t.serverSeq),
  ],
);
