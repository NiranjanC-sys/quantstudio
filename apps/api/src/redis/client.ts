/**
 * Redis access (system-design §5). One client for commands, one for pub/sub
 * subscriptions, because a subscribed connection cannot issue normal commands.
 */
import { Redis, type RedisOptions } from 'ioredis';
import type { Env } from '../env.js';

export interface RedisHandles {
  /** Command connection: sessions, rate limits, leaderboards, caches. */
  client: Redis;
  /** Dedicated subscriber for `ws:contest:{id}` / `ws:user:{id}` fanout. */
  subscriber: Redis;
  /** Publisher, kept separate so a slow subscriber cannot stall publishes. */
  publisher: Redis;
  ping(): Promise<boolean>;
  close(): Promise<void>;
}

function options(env: Env): RedisOptions {
  return {
    keyPrefix: env.REDIS_KEY_PREFIX,
    lazyConnect: false,
    maxRetriesPerRequest: 3,
    enableReadyCheck: true,
    connectTimeout: 5_000,
    // Exponential-ish backoff capped at 2 s, so a Redis blip degrades latency
    // rather than turning into a reconnect storm from 60 pods.
    retryStrategy: (times: number) => Math.min(2_000, 50 * 2 ** Math.min(times, 6)),
  };
}

export function createRedis(env: Env): RedisHandles {
  const client = new Redis(env.REDIS_URL, options(env));
  const subscriber = new Redis(env.REDIS_URL, options(env));
  const publisher = new Redis(env.REDIS_URL, options(env));

  for (const conn of [client, subscriber, publisher]) {
    conn.on('error', () => undefined);
  }

  return {
    client,
    subscriber,
    publisher,
    async ping() {
      try {
        return (await client.ping()) === 'PONG';
      } catch {
        return false;
      }
    },
    async close() {
      await Promise.all([client.quit(), subscriber.quit(), publisher.quit()].map((p) => p.catch(() => undefined)));
    },
  };
}

/**
 * Redis Cluster hashes keys by the `{...}` slot tag. Every multi-key Lua script
 * in this codebase pins its keys to one slot by embedding the same tag, which is
 * what makes `SETNX solved:{c}:{u}:{p}` and `ZINCRBY lb:{c}` scriptable together
 * (system-design §6).
 */
export function slotTag(value: string): string {
  return `{${value}}`;
}
