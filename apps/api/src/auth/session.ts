/**
 * Sessions (system-design §8):
 *
 *   "opaque 256-bit id in an HttpOnly; Secure; SameSite=Lax cookie, Redis-backed,
 *    sliding 14 d, rotated on privilege change."
 *
 * Redis is the hot path; `identity.sessions` carries the durable audit record so
 * "sign out everywhere" and incident forensics survive a Redis flush. Only the
 * SHA-256 of the token is ever stored — a dump of either store yields no usable
 * credential.
 */
import { eq, sql } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import type { DatabaseHandles } from '../db/client.js';
import { sessions as sessionsTable } from '../db/schema/identity.js';
import type { Env } from '../env.js';
import { generateOpaqueToken, sha256Hex } from '../lib/crypto.js';
import { keys } from '../redis/scripts.js';
import type { AuthContext, SessionRecord } from './types.js';

export interface CreateSessionInput extends Omit<SessionRecord, 'createdAtMs' | 'expiresAtMs'> {}

export interface IssuedSession {
  /** The value that goes in the cookie. Never persisted anywhere. */
  token: string;
  sessionKey: string;
  record: SessionRecord;
}

export interface SessionStore {
  create(input: CreateSessionInput): Promise<IssuedSession>;
  resolve(token: string): Promise<AuthContext | null>;
  /** §8: rotate on privilege change — new id, old id destroyed atomically. */
  rotate(token: string, changes: Partial<CreateSessionInput>): Promise<IssuedSession | null>;
  patch(sessionKey: string, changes: Partial<SessionRecord>): Promise<void>;
  destroy(token: string, reason: string): Promise<void>;
  destroyByKey(sessionKey: string, reason: string): Promise<void>;
  destroyAllForUser(userId: string, reason: string, exceptKey?: string): Promise<number>;
  listForUser(userId: string): Promise<Array<{ sessionKey: string; record: SessionRecord }>>;
  hashToken(token: string): string;
}

export function createSessionStore(
  env: Env,
  db: DatabaseHandles,
  redis: Redis,
): SessionStore {
  const ttlSeconds = env.SESSION_TTL_SECONDS;

  /** Sliding window: only rewrite when more than half the TTL has elapsed. */
  const REFRESH_THRESHOLD = ttlSeconds / 2;

  async function persist(sessionKey: string, record: SessionRecord): Promise<void> {
    const ttl = Math.max(1, Math.ceil((record.expiresAtMs - Date.now()) / 1000));
    await redis
      .multi()
      .set(keys.session(sessionKey), JSON.stringify(record), 'EX', ttl)
      .sadd(keys.userSessions(record.userId), sessionKey)
      .expire(keys.userSessions(record.userId), ttlSeconds)
      .exec();
  }

  async function readRecord(sessionKey: string): Promise<SessionRecord | null> {
    const raw = await redis.get(keys.session(sessionKey));
    if (!raw) return null;
    try {
      return JSON.parse(raw) as SessionRecord;
    } catch {
      // A corrupt value is treated as no session rather than a 500.
      await redis.del(keys.session(sessionKey));
      return null;
    }
  }

  return {
    hashToken: (token) => sha256Hex(token),

    async create(input) {
      const token = generateOpaqueToken(32);
      const sessionKey = sha256Hex(token);
      const now = Date.now();
      const record: SessionRecord = {
        ...input,
        createdAtMs: now,
        expiresAtMs: now + ttlSeconds * 1000,
      };

      await persist(sessionKey, record);

      await db.primary
        .insert(sessionsTable)
        .values({
          id: sessionKey,
          userId: record.userId,
          amr: record.amr,
          privilegeVersion: record.privilegeVersion,
          mfaSatisfied: record.mfaSatisfied,
          ipHash: record.ipHash,
          uaHash: record.uaHash,
          createdAt: new Date(now),
          lastSeenAt: new Date(now),
          expiresAt: new Date(record.expiresAtMs),
        })
        .onConflictDoNothing();

      return { token, sessionKey, record };
    },

    async resolve(token) {
      if (!token) return null;
      const sessionKey = sha256Hex(token);
      const record = await readRecord(sessionKey);
      if (!record) return null;

      if (record.expiresAtMs <= Date.now()) {
        await this.destroyByKey(sessionKey, 'expired');
        return null;
      }

      // Sliding expiry. The Postgres row is only touched when the Redis TTL is
      // actually extended, which keeps steady-state session traffic Redis-only.
      const remaining = (record.expiresAtMs - Date.now()) / 1000;
      if (remaining < REFRESH_THRESHOLD) {
        const extended: SessionRecord = {
          ...record,
          expiresAtMs: Date.now() + ttlSeconds * 1000,
        };
        await persist(sessionKey, extended);
        await db.primary
          .update(sessionsTable)
          .set({ lastSeenAt: new Date(), expiresAt: new Date(extended.expiresAtMs) })
          .where(eq(sessionsTable.id, sessionKey));
        return { ...extended, sessionKey };
      }

      return { ...record, sessionKey };
    },

    async patch(sessionKey, changes) {
      const record = await readRecord(sessionKey);
      if (!record) return;
      await persist(sessionKey, { ...record, ...changes });
    },

    async rotate(token, changes) {
      const sessionKey = sha256Hex(token);
      const record = await readRecord(sessionKey);
      if (!record) return null;

      const issued = await this.create({
        userId: record.userId,
        email: record.email,
        handle: record.handle,
        role: record.role,
        orgId: record.orgId,
        orgRole: record.orgRole,
        amr: record.amr,
        mfaSatisfied: record.mfaSatisfied,
        privilegeVersion: record.privilegeVersion,
        plan: record.plan,
        entitlements: record.entitlements,
        entitlementStamp: record.entitlementStamp,
        ipHash: record.ipHash,
        uaHash: record.uaHash,
        ...changes,
      });

      await this.destroyByKey(sessionKey, 'rotated');
      return issued;
    },

    async destroy(token, reason) {
      await this.destroyByKey(sha256Hex(token), reason);
    },

    async destroyByKey(sessionKey, reason) {
      const record = await readRecord(sessionKey);
      await redis.del(keys.session(sessionKey));
      if (record) {
        await redis.srem(keys.userSessions(record.userId), sessionKey);
      }
      await db.primary
        .update(sessionsTable)
        .set({ revokedAt: new Date(), revokedReason: reason })
        .where(eq(sessionsTable.id, sessionKey));
    },

    async destroyAllForUser(userId, reason, exceptKey) {
      const members = await redis.smembers(keys.userSessions(userId));
      const doomed = members.filter((key) => key !== exceptKey);

      if (doomed.length > 0) {
        const pipeline = redis.multi();
        for (const key of doomed) {
          pipeline.del(keys.session(key));
          pipeline.srem(keys.userSessions(userId), key);
        }
        await pipeline.exec();
      }

      // Postgres is updated by user, not by key, so a session that only exists
      // in the audit table (Redis already expired it) is also marked revoked.
      await db.primary
        .update(sessionsTable)
        .set({ revokedAt: new Date(), revokedReason: reason })
        .where(
          exceptKey
            ? sql`${sessionsTable.userId} = ${userId} and ${sessionsTable.revokedAt} is null and ${sessionsTable.id} <> ${exceptKey}`
            : sql`${sessionsTable.userId} = ${userId} and ${sessionsTable.revokedAt} is null`,
        );

      return doomed.length;
    },

    async listForUser(userId) {
      const members = await redis.smembers(keys.userSessions(userId));
      if (members.length === 0) return [];
      const raw = await redis.mget(members.map((key) => keys.session(key)));
      const out: Array<{ sessionKey: string; record: SessionRecord }> = [];
      members.forEach((key, index) => {
        const value = raw[index];
        if (!value) return;
        try {
          out.push({ sessionKey: key, record: JSON.parse(value) as SessionRecord });
        } catch {
          // Ignore unparseable entries; `resolve` cleans them up on next use.
        }
      });
      return out;
    },
  };
}
