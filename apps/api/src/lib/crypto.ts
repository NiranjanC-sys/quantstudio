/**
 * Small cryptographic helpers. Everything security-relevant that is not a
 * password, a passkey or a JWT lives here, so the primitives are auditable in
 * one place.
 */
import {
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';

/** system-design §8: opaque 256-bit session identifier. */
export function generateOpaqueToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export function sha256Hex(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

export function sha256Base64Url(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('base64url');
}

export function hmacHex(secret: string, value: string): string {
  return createHmac('sha256', secret).update(value).digest('hex');
}

/**
 * Constant-time comparison that does not leak length through an early return.
 * Both sides are hashed first, which makes the compared buffers equal-length.
 */
export function safeEqual(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb);
}

/**
 * Pseudonymises an IP or user agent for storage and logging. system-design §11
 * requires logs with no PII; a keyed digest keeps the value useful for abuse
 * clustering while being unusable as an identifier outside the deployment.
 */
export function pseudonymise(secret: string, value: string | undefined | null): string | null {
  if (!value) return null;
  return createHmac('sha256', secret).update(value).digest('hex').slice(0, 32);
}

export { randomUUID };

/**
 * Normalises submitted source into the AST-ish hash used for exact-duplicate
 * detection across users (system-design §6, anti-cheat). Comments, blank lines
 * and indentation are removed, string literals are collapsed, and identifiers
 * keep their names — renaming is caught by the shadow rerun, not by this.
 */
export function normalisedSourceHash(source: string): string {
  const normalised = source
    .replace(/(['"])(?:\\.|(?!\1)[^\\])*\1/g, '"S"')
    .replace(/#.*$/gm, '')
    .replace(/\/\/.*$/gm, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return sha256Hex(normalised);
}
