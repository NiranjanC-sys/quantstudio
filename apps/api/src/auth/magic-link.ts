/**
 * Email magic links (system-design §8).
 *
 * The link carries a 256-bit opaque token; only its SHA-256 is stored. Tokens
 * are single-use — consumption is a conditional UPDATE, so two clicks race
 * safely and the loser is told the link is spent — and short-lived.
 */
import { and, eq, isNull, sql } from 'drizzle-orm';
import type { DatabaseHandles } from '../db/client.js';
import { magicLinks, users } from '../db/schema/identity.js';
import type { Env } from '../env.js';
import { ApiError } from '../errors.js';
import { generateOpaqueToken, sha256Hex } from '../lib/crypto.js';
import type { Mailer } from '../lib/mailer.js';

export interface MagicLinkService {
  issue(input: { email: string; redirectTo: string }): Promise<{ expiresAt: Date }>;
  consume(token: string): Promise<{ email: string; userId: string | null; redirectTo: string }>;
}

export function createMagicLinkService(
  env: Env,
  db: DatabaseHandles,
  mailer: Mailer,
): MagicLinkService {
  return {
    async issue({ email, redirectTo }) {
      const normalised = email.trim().toLowerCase();

      const existing = await db.replica
        .select({ id: users.id })
        .from(users)
        .where(sql`lower(${users.email}) = ${normalised}`)
        .limit(1);

      const token = generateOpaqueToken(32);
      const expiresAt = new Date(Date.now() + env.MAGIC_LINK_TTL_SECONDS * 1000);

      await db.primary.insert(magicLinks).values({
        email: normalised,
        userId: existing[0]?.id ?? null,
        tokenHash: sha256Hex(token),
        redirectTo,
        expiresAt,
      });

      const url = new URL('/auth/magic-link/callback', env.API_PUBLIC_URL);
      url.searchParams.set('token', token);

      await mailer.send({
        to: normalised,
        subject: 'Your RedQuant sign-in link',
        template: 'magic-link',
        variables: {
          url: url.href,
          expiresInMinutes: String(Math.round(env.MAGIC_LINK_TTL_SECONDS / 60)),
        },
      });

      return { expiresAt };
    },

    async consume(token) {
      const tokenHash = sha256Hex(token);

      // Single statement: the `consumed_at is null` predicate is the mutual
      // exclusion, so a double click cannot mint two sessions.
      const consumed = await db.primary
        .update(magicLinks)
        .set({ consumedAt: new Date() })
        .where(
          and(
            eq(magicLinks.tokenHash, tokenHash),
            isNull(magicLinks.consumedAt),
            sql`${magicLinks.expiresAt} > now()`,
          ),
        )
        .returning({
          email: magicLinks.email,
          userId: magicLinks.userId,
          redirectTo: magicLinks.redirectTo,
        });

      const row = consumed[0];
      if (!row) {
        throw new ApiError('unauthorized', 'This sign-in link is invalid, expired or already used.');
      }

      return {
        email: row.email,
        userId: row.userId,
        redirectTo: row.redirectTo ?? env.WEB_PUBLIC_URL,
      };
    },
  };
}
