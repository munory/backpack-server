import { type Static, type TSchema, Type } from '@fastify/type-provider-typebox';

// What travels between the app and the server in POST /sync — the contract
// the app's sync code has to follow. Mirrors the app's SQLite tables, with
// references as uuids (the app's local integer ids mean nothing elsewhere).
// Times are ms since the epoch. Enums are the app's enum index:
// packType 0 food, 1 gear, 2 water; condition 0 newItem, 1 needsReplacement,
// 2 wornOut.

const Uuid = Type.String({ format: 'uuid' });
const Ms = Type.Integer({ minimum: 0 });
const Name = Type.String({ maxLength: 500 });
const Grams = Type.Integer({ minimum: 0, maximum: 1_000_000_000 });
const PackType = Type.Integer({ minimum: 0, maximum: 2 });
/**
 * "This or null". Null is listed first on purpose: Fastify's validator
 * converts types where it can, and checking "string" first would quietly
 * turn a null into "" (or 0 for a number) before ever trying "null".
 */
const Nullable = <T extends TSchema>(schema: T) => Type.Union([Type.Null(), schema]);

export const CategoryWire = Type.Object(
  {
    uuid: Uuid,
    name: Name,
    parentUuid: Nullable(Uuid),
    packType: PackType,
    icon: Nullable(Type.String({ maxLength: 50 })),
    color: Nullable(Type.String({ maxLength: 50 })),
    updatedAt: Ms,
  },
  { additionalProperties: false },
);

export const ItemWire = Type.Object(
  {
    uuid: Uuid,
    name: Name,
    weightGrams: Grams,
    categoryUuid: Nullable(Uuid),
    condition: Type.Integer({ minimum: 0, maximum: 2 }),
    packType: Nullable(PackType),
    quantity: Type.Integer({ minimum: 1, maximum: 100_000 }),
    worn: Type.Boolean(),
    updatedAt: Ms,
  },
  { additionalProperties: false },
);

export const TripWire = Type.Object(
  {
    uuid: Uuid,
    name: Name,
    targetWeightGrams: Nullable(Grams),
    createdAtMs: Ms,
    startDate: Nullable(Ms),
    endDate: Nullable(Ms),
    isDraft: Type.Boolean(),
    updatedAt: Ms,
  },
  { additionalProperties: false },
);

export const TripItemWire = Type.Object(
  {
    tripUuid: Uuid,
    itemUuid: Uuid,
    quantity: Nullable(Type.Integer({ minimum: 1, maximum: 100_000 })),
    inBag: Type.Boolean(),
    updatedAt: Ms,
  },
  { additionalProperties: false },
);

export const Entity = Type.Union([
  Type.Literal('categories'),
  Type.Literal('items'),
  Type.Literal('trips'),
  Type.Literal('trip_items'),
]);

export const DeletionWire = Type.Object(
  {
    entity: Entity,
    /** The row's uuid — for trip_items, "tripUuid/itemUuid". */
    key: Type.String({ maxLength: 80 }),
    deletedAt: Ms,
  },
  { additionalProperties: false },
);

/** At most this many rows of each kind per request; the app sends more in turns. */
const MAX_PER_REQUEST = 1000;
const list = <T extends Parameters<typeof Type.Array>[0]>(of: T) =>
  Type.Array(of, { maxItems: MAX_PER_REQUEST, default: [] });

export const Changes = Type.Object(
  {
    categories: list(CategoryWire),
    items: list(ItemWire),
    trips: list(TripWire),
    tripItems: list(TripItemWire),
  },
  { additionalProperties: false },
);

export const SyncRequest = Type.Object(
  {
    /** The `cursor` from the previous response; 0 on a device's first sync. */
    cursor: Type.Integer({ minimum: 0 }),
    changes: Type.Optional(Changes),
    deletions: Type.Optional(list(DeletionWire)),
    /** How many changed rows to return at most (default 500). */
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000 })),
  },
  { additionalProperties: false },
);

export type CategoryWire = Static<typeof CategoryWire>;
export type ItemWire = Static<typeof ItemWire>;
export type TripWire = Static<typeof TripWire>;
export type TripItemWire = Static<typeof TripItemWire>;
export type DeletionWire = Static<typeof DeletionWire>;
export type Entity = Static<typeof Entity>;
export type Changes = Static<typeof Changes>;
export type SyncRequest = Static<typeof SyncRequest>;

export interface SyncResponse {
  /** Send this back next time. */
  cursor: number;
  /** True when there's more than fit — sync again right away to get it. */
  hasMore: boolean;
  changes: Changes;
  deletions: DeletionWire[];
}
