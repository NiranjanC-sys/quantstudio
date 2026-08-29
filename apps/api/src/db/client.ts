/**
 * Postgres access. system-design §5: writes go to the primary through PgBouncer
 * (transaction pooling), reads go to replicas — except reads inside a write
 * transaction and reads within 500 ms of the user's own write, which the
 * read-your-own-writes middleware routes back to the primary.
 */
import { sql } from 'drizzle-orm';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import type { Env } from '../env.js';
import * as schema from './schema/index.js';

export type Schema = typeof schema;
export type Db = NodePgDatabase<Schema>;
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
/** Anything you can run a query on: the pool-backed handle or an open transaction. */
export type Queryable = Db | Tx;

export interface DatabaseHandles {
  /** Primary: all writes, and any read that must observe the caller's own write. */
  primary: Db;
  /** Replica pool. Identical to `primary` when no replica URL is configured. */
  replica: Db;
  /** `true` when a distinct replica pool exists. */
  hasReplica: boolean;
  /** Chooses a handle for a read given the read-your-own-writes decision. */
  read(mustHitPrimary: boolean): Db;
  ping(): Promise<{ primary: boolean; replica: boolean }>;
  close(): Promise<void>;
  pools: { primary: pg.Pool; replica: pg.Pool | null };
}

function makePool(connectionString: string, max: number, env: Env): pg.Pool {
  return new pg.Pool({
    connectionString,
    max,
    // PgBouncer in transaction-pooling mode closes idle server connections for
    // us; keeping client-side idles short avoids stale sockets after a failover.
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    statement_timeout: env.DATABASE_STATEMENT_TIMEOUT_MS,
    query_timeout: env.DATABASE_STATEMENT_TIMEOUT_MS,
    application_name: `redquant-api/${env.CELL_ID}`,
    ...(env.DATABASE_SSL ? { ssl: { rejectUnauthorized: true } } : {}),
  });
}

export function createDatabase(env: Env): DatabaseHandles {
  const primaryPool = makePool(env.DATABASE_URL, env.DATABASE_POOL_MAX, env);
  const replicaPool =
    env.DATABASE_REPLICA_URL && env.DATABASE_REPLICA_URL !== env.DATABASE_URL
      ? makePool(env.DATABASE_REPLICA_URL, env.DATABASE_REPLICA_POOL_MAX, env)
      : null;

  // A pool-level error (server restart, failover) must not take the process
  // down; pg re-creates the connection on the next checkout.
  primaryPool.on('error', () => undefined);
  replicaPool?.on('error', () => undefined);

  const primary = drizzle(primaryPool, { schema, logger: false });
  const replica = replicaPool ? drizzle(replicaPool, { schema, logger: false }) : primary;

  return {
    primary,
    replica,
    hasReplica: replicaPool !== null,
    read(mustHitPrimary: boolean): Db {
      return mustHitPrimary ? primary : replica;
    },
    async ping() {
      const check = async (db: Db): Promise<boolean> => {
        try {
          await db.execute(sql`select 1`);
          return true;
        } catch {
          return false;
        }
      };
      const [p, r] = await Promise.all([check(primary), replicaPool ? check(replica) : check(primary)]);
      return { primary: p, replica: r };
    },
    async close() {
      await primaryPool.end();
      if (replicaPool) await replicaPool.end();
    },
    pools: { primary: primaryPool, replica: replicaPool },
  };
}

export { schema };
