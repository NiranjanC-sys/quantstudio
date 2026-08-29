/**
 * Argon2id password hashing, at the parameters system-design §8 specifies:
 * m = 64 MiB, t = 3, p = 4.
 *
 * §8 also says passwords "exist only for legacy import" — passkeys, OIDC and
 * magic links are the intended paths — but the import path has to be correct, so
 * this is a full implementation including rehash-on-login when parameters move.
 */
import { hash, verify, type Options } from '@node-rs/argon2';
import type { Env } from '../env.js';

export interface PasswordPolicyIssue {
  rule: 'length' | 'complexity' | 'common';
  message: string;
}

/**
 * NIST SP 800-63B: length is what matters, composition rules mostly are not.
 * The blocklist is intentionally small here; the deployment feeds a real
 * breached-password list through `extraBlocklist`.
 */
const COMMON = new Set([
  'password',
  'password1',
  '12345678',
  'qwertyui',
  'letmein1',
  'iloveyou',
  'quantum1',
  'redquant',
]);

export function validatePassword(
  password: string,
  extraBlocklist: ReadonlySet<string> = new Set(),
): PasswordPolicyIssue[] {
  const issues: PasswordPolicyIssue[] = [];

  if (password.length < 12) {
    issues.push({ rule: 'length', message: 'Password must be at least 12 characters.' });
  }
  if (password.length > 256) {
    issues.push({ rule: 'length', message: 'Password must be at most 256 characters.' });
  }

  const lowered = password.toLowerCase();
  if (COMMON.has(lowered) || extraBlocklist.has(lowered)) {
    issues.push({ rule: 'common', message: 'That password appears in a breach corpus.' });
  }

  // A single repeated character is long but carries no entropy.
  if (/^(.)\1*$/.test(password)) {
    issues.push({ rule: 'complexity', message: 'Password must not be a single repeated character.' });
  }

  return issues;
}

/**
 * `@node-rs/argon2` declares `Algorithm`/`Version` as ambient const enums, which
 * `isolatedModules` cannot read, so their ordinals are pinned here by name.
 *
 * Note the two different numbers for the same thing: the binding's `Version`
 * enum is ordinal (`V0x10 = 0`, `V0x13 = 1`), while the PHC string spells the
 * same version as `v=19`. Conflating them makes `hash()` throw at runtime and
 * `needsRehash()` rehash every digest for ever, so they are separate constants.
 */
const ARGON2ID = 2;
/** `Version.V0x13`, the ordinal the native binding expects in `Options`. */
const ARGON2_VERSION_ENUM_V0X13 = 1;
/** The same version as it appears in a PHC digest: `$argon2id$v=19$…`. */
const PHC_VERSION_0X13 = 19;

/** `$argon2id$v=19$m=65536,t=3,p=4$<salt>$<hash>` */
const PHC_PATTERN = /^\$argon2(id|i|d)\$v=(\d+)\$m=(\d+),t=(\d+),p=(\d+)\$/;

export interface ParsedDigest {
  variant: string;
  version: number;
  memoryCost: number;
  timeCost: number;
  parallelism: number;
}

export function parseDigest(digest: string): ParsedDigest | null {
  const match = PHC_PATTERN.exec(digest);
  if (!match) return null;
  return {
    variant: `argon2${match[1] as string}`,
    version: Number(match[2]),
    memoryCost: Number(match[3]),
    timeCost: Number(match[4]),
    parallelism: Number(match[5]),
  };
}

export interface PasswordHasher {
  hash(password: string): Promise<string>;
  verify(digest: string, password: string): Promise<boolean>;
  /** True when the stored digest used weaker parameters than the current policy. */
  needsRehash(digest: string): boolean;
}

export function createPasswordHasher(env: Env): PasswordHasher {
  const options: Options = {
    algorithm: ARGON2ID as NonNullable<Options['algorithm']>,
    version: ARGON2_VERSION_ENUM_V0X13 as NonNullable<Options['version']>,
    memoryCost: env.ARGON2_MEMORY_KIB,
    timeCost: env.ARGON2_TIME_COST,
    parallelism: env.ARGON2_PARALLELISM,
  };

  return {
    hash: (password) => hash(password, options),
    verify: async (digest, password) => {
      try {
        return await verify(digest, password, options);
      } catch {
        // A malformed or truncated digest is a failed login, not a 500.
        return false;
      }
    },
    // The binding exposes no needsRehash, so the PHC parameters are compared
    // directly. A legacy import hashed at weaker settings is upgraded silently
    // on the owner's next successful login.
    needsRehash: (digest) => {
      const parsed = parseDigest(digest);
      if (!parsed) return true;
      return (
        parsed.variant !== 'argon2id' ||
        parsed.version !== PHC_VERSION_0X13 ||
        parsed.memoryCost < env.ARGON2_MEMORY_KIB ||
        parsed.timeCost < env.ARGON2_TIME_COST ||
        parsed.parallelism !== env.ARGON2_PARALLELISM
      );
    },
  };
}
