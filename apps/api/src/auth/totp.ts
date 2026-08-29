/**
 * RFC 6238 TOTP over RFC 4226 HOTP, for the MFA that system-design §8 requires
 * of `instructor` and `org_admin`.
 *
 * Implemented directly on node:crypto: the algorithm is thirty lines and an
 * extra dependency in the authentication path is a liability, not a convenience.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function generateTotpSecret(bytes = 20): string {
  return base32Encode(randomBytes(bytes));
}

export function base32Encode(buffer: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = '';

  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }
  return output;
}

export function base32Decode(input: string): Buffer {
  const clean = input.toUpperCase().replace(/=+$/, '').replace(/\s/g, '');
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];

  for (const char of clean) {
    const index = BASE32_ALPHABET.indexOf(char);
    if (index === -1) throw new Error('Invalid base32 character in TOTP secret.');
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

export interface TotpOptions {
  digits: number;
  periodSeconds: number;
  algorithm: 'sha1' | 'sha256' | 'sha512';
  /** How many periods either side of now are accepted, for clock skew. */
  window: number;
}

export const DEFAULT_TOTP: TotpOptions = {
  digits: 6,
  periodSeconds: 30,
  algorithm: 'sha1',
  window: 1,
};

export function totpCode(
  secret: string,
  counter: number,
  options: TotpOptions = DEFAULT_TOTP,
): string {
  const key = base32Decode(secret);
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64BE(BigInt(counter));

  const digest = createHmac(options.algorithm, key).update(buffer).digest();
  const offset = (digest[digest.length - 1] as number) & 0x0f;
  const binary =
    (((digest[offset] as number) & 0x7f) << 24) |
    (((digest[offset + 1] as number) & 0xff) << 16) |
    (((digest[offset + 2] as number) & 0xff) << 8) |
    ((digest[offset + 3] as number) & 0xff);

  return (binary % 10 ** options.digits).toString().padStart(options.digits, '0');
}

/**
 * Verifies a code within the skew window. Returns the counter that matched so
 * the caller can store it and refuse replays of the same code.
 */
export function verifyTotp(
  secret: string,
  code: string,
  now: Date = new Date(),
  options: TotpOptions = DEFAULT_TOTP,
): { valid: boolean; counter: number | null } {
  const trimmed = code.trim();
  if (!/^\d+$/.test(trimmed) || trimmed.length !== options.digits) {
    return { valid: false, counter: null };
  }

  const counter = Math.floor(now.getTime() / 1000 / options.periodSeconds);
  const candidate = Buffer.from(trimmed);

  for (let offset = -options.window; offset <= options.window; offset += 1) {
    const expected = Buffer.from(totpCode(secret, counter + offset, options));
    if (expected.length === candidate.length && timingSafeEqual(expected, candidate)) {
      return { valid: true, counter: counter + offset };
    }
  }

  return { valid: false, counter: null };
}

/** `otpauth://` URI for an authenticator app's QR code. */
export function totpUri(
  secret: string,
  accountName: string,
  issuer = 'RedQuant',
  options: TotpOptions = DEFAULT_TOTP,
): string {
  const label = encodeURIComponent(`${issuer}:${accountName}`);
  const params = new URLSearchParams({
    secret,
    issuer,
    algorithm: options.algorithm.toUpperCase(),
    digits: String(options.digits),
    period: String(options.periodSeconds),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

/** Single-use recovery codes, shown once at enrolment and stored hashed. */
export function generateRecoveryCodes(count = 10): string[] {
  return Array.from({ length: count }, () => {
    const raw = randomBytes(5).toString('hex').toUpperCase();
    return `${raw.slice(0, 5)}-${raw.slice(5, 10)}`;
  });
}
