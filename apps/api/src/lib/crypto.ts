/**
 * Small cryptographic helpers. Everything security-relevant that is not a
 * password, a passkey or a JWT lives here, so the primitives are auditable in
 * one place.
 */
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
  scryptSync,
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

/**
 * Authenticated symmetric encryption for the few secrets that must be
 * recoverable rather than merely verifiable — today that is the TOTP seed in
 * `identity.mfa_methods.secret`, which the server has to replay to check a code.
 *
 * AES-256-GCM with a random 96-bit IV, key derived from the configured secret by
 * scrypt so an operator can supply a passphrase rather than 32 raw bytes. The
 * output is `v1.<iv>.<tag>.<ciphertext>`, all base64url, which is
 * self-describing enough to rotate the scheme later without guessing.
 */
const SECRET_BOX_VERSION = 'v1';
const SECRET_BOX_SALT = 'redquant/secret-box/v1';

function secretBoxKey(secret: string): Buffer {
  return scryptSync(secret, SECRET_BOX_SALT, 32);
}

export function encryptSecret(secret: string, plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', secretBoxKey(secret), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    SECRET_BOX_VERSION,
    iv.toString('base64url'),
    tag.toString('base64url'),
    ciphertext.toString('base64url'),
  ].join('.');
}

/** Returns `null` for anything that does not decrypt and authenticate cleanly. */
export function decryptSecret(secret: string, envelope: string): string | null {
  const parts = envelope.split('.');
  if (parts.length !== 4 || parts[0] !== SECRET_BOX_VERSION) return null;
  try {
    const decipher = createDecipheriv(
      'aes-256-gcm',
      secretBoxKey(secret),
      Buffer.from(parts[1] as string, 'base64url'),
    );
    decipher.setAuthTag(Buffer.from(parts[2] as string, 'base64url'));
    return Buffer.concat([
      decipher.update(Buffer.from(parts[3] as string, 'base64url')),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    return null;
  }
}
