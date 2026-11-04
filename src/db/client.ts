import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';

/**
 * The connection to PostgreSQL. `postgres` is the driver — it actually talks
 * to the database over the network; Drizzle sits on top of it, the way Drift
 * sits on top of SQLite in the app: tables and queries written in TypeScript,
 * checked by the compiler.
 */
export function createDatabase(url: string) {
  const client = postgres(url, {
    // A pool of up to 10 connections, reused across requests rather than
    // opening a new one each time.
    max: 10,
    // Give up after 5 s instead of hanging when the database is down.
    connect_timeout: 5,
  });
  const db = drizzle(client);

  return {
    db,
    /** Resolves if the database answers, throws if it doesn't. */
    async ping(): Promise<void> {
      await db.execute(sql`select 1`);
    },
    /** Closes every connection — on shutdown. */
    close: () => client.end(),
  };
}

export type Database = ReturnType<typeof createDatabase>;
/** The Drizzle instance queries are written against. */
export type Db = Database['db'];
