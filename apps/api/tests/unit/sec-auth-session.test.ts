/**
 * Defensive security review — authentication and sessions (system-design §8).
 *
 * These tests are written to *prove* findings by execution rather than by
 * reading. Each `it(...)` name states the property §8 promises; a failing test
 * before the fix and a passing one after is the evidence.
 *
 * They need the same real Postgres/Redis pair the integration suite uses,
 * because a session is a Redis record plus a Postgres audit row and neither
 * half can be faked without testing the fake instead of the system.
 */
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BuiltApp } from '../../src/app.js';
import { buildApp } from '../../src/app.js';
import { loadEnv, type Env } from '../../src/env.js';
import { magicLinks, mfaMethods, users } from '../../src/db/schema/identity.js';
import { createMagicLinkService } from '../../src/auth/magic-link.js';
import { decryptSecret } from '../../src/lib/crypto.js';
import { totpCode } from '../../src/auth/totp.js';
import type { Mailer, OutboundEmail } from '../../src/lib/mailer.js';
import {
  HAS_POSTGRES,
  HAS_REDIS,
  requireDatabaseUrl,
  requireRedisUrl,
} from '../support/environment.js';

const skip = !HAS_POSTGRES || !HAS_REDIS;
if (skip) {
  process.stderr.write(
    '[sec-auth-session.test] Postgres and/or Redis are not available; the suite is SKIPPED.\n',
  );
}

interface Session {
  cookie: string;
  csrf: string;
  sessionToken: string;
  userId: string;
  email: string;
}

describe.skipIf(skip)('§8 authentication and session security', () => {
  let built: BuiltApp;
  let env: Env;
  let ipCounter = 100;

  beforeAll(async () => {
    env = loadEnv({
      ...process.env,
      NODE_ENV: 'test',
      DATABASE_URL: requireDatabaseUrl(),
      REDIS_URL: requireRedisUrl(),
      SESSION_COOKIE_SECURE: 'false',
      LOG_LEVEL: 'silent',
      METRICS_ENABLED: 'false',
      RATE_LIMIT_ENABLED: 'false',
      EMAIL_TRANSPORT: 'console',
    });
    built = await buildApp(env);
  }, 180_000);

  afterAll(async () => {
    if (built) await built.close();
  });

  function nextIp(): string {
    ipCounter += 1;
    return `198.51.100.${ipCounter % 250}`;
  }

  function readJar(setCookies: string | string[] | undefined): Map<string, string> {
    const jar = Array.isArray(setCookies) ? setCookies : setCookies ? [String(setCookies)] : [];
    const out = new Map<string, string>();
    for (const entry of jar) {
      const pair = entry.split(';')[0] as string;
      const name = pair.slice(0, pair.indexOf('='));
      out.set(name, decodeURIComponent(pair.slice(pair.indexOf('=') + 1)));
    }
    return out;
  }

  async function register(suffix: string): Promise<Session> {
    const email = `sec-${suffix}-${Date.now()}-${ipCounter}@example.com`;
    const response = await built.app.inject({
      method: 'POST',
      url: '/auth/register',
      headers: { 'x-forwarded-for': nextIp() },
      payload: { email, password: 'correct-horse-battery-staple', displayName: 'Sec Review' },
    });
    expect(response.statusCode).toBe(201);

    const jar = readJar(response.headers['set-cookie']);
    const sessionToken = jar.get(env.SESSION_COOKIE_NAME) as string;
    const csrf = jar.get(env.CSRF_COOKIE_NAME) as string;
    expect(sessionToken).toBeTruthy();

    return {
      cookie: `${env.SESSION_COOKIE_NAME}=${sessionToken}; ${env.CSRF_COOKIE_NAME}=${csrf}`,
      csrf,
      sessionToken,
      userId: (response.json() as { user: { id: string } }).user.id,
      email,
    };
  }

  function headersFor(session: Session, extra: Record<string, string> = {}) {
    return {
      cookie: session.cookie,
      'x-csrf-token': session.csrf,
      'x-forwarded-for': nextIp(),
      ...extra,
    };
  }

  /** Enrols and confirms TOTP, returning the shared secret. */
  async function enrolTotp(session: Session): Promise<string> {
    const enrol = await built.app.inject({
      method: 'POST',
      url: '/auth/mfa/totp/enroll',
      headers: headersFor(session),
      payload: {},
    });
    expect(enrol.statusCode).toBe(201);
    return (enrol.json() as { secret: string }).secret;
  }

  function codeFor(secret: string, offset = 0): string {
    return totpCode(secret, Math.floor(Date.now() / 1000 / 30) + offset);
  }

  // ------------------------------------------------------------------ #1
  describe('session id rotation on privilege change', () => {
    it('issues a new session id when MFA step-up elevates the session', async () => {
      const session = await register('rotate');
      const secret = await enrolTotp(session);

      const confirm = await built.app.inject({
        method: 'POST',
        url: '/auth/mfa/totp/confirm',
        headers: headersFor(session),
        payload: { code: codeFor(secret) },
      });
      expect(confirm.statusCode).toBe(200);

      const jar = readJar(confirm.headers['set-cookie']);
      const rotated = jar.get(env.SESSION_COOKIE_NAME);

      // The privilege of this session changed: mfaSatisfied went false -> true.
      // §8 requires the identifier to be replaced when that happens.
      const before = await built.app.inject({
        method: 'GET',
        url: '/auth/session',
        headers: { cookie: session.cookie, 'x-forwarded-for': nextIp() },
      });

      expect(rotated, 'no new session cookie was issued on MFA step-up').toBeTruthy();
      expect(rotated).not.toBe(session.sessionToken);
      // And the pre-elevation identifier must no longer be a credential at all.
      expect(before.json()).toMatchObject({ authenticated: false });
    });
  });

  // ------------------------------------------------------------------ #2
  describe('redirect targets', () => {
    it('refuses an off-site redirectTo on the magic-link callback', async () => {
      const captured: OutboundEmail[] = [];
      const mailer: Mailer = {
        async send(message) {
          captured.push(message);
        },
      };
      const service = createMagicLinkService(env, built.services.db, mailer);

      const victim = await register('openredir');
      await service.issue({
        email: victim.email,
        redirectTo: 'https://evil.example.com/harvest',
      });

      const url = new URL((captured[0] as OutboundEmail).variables['url'] as string);
      const token = url.searchParams.get('token') as string;
      expect(token).toBeTruthy();

      const response = await built.app.inject({
        method: 'GET',
        url: `/auth/magic-link/callback?token=${encodeURIComponent(token)}`,
        headers: { 'x-forwarded-for': nextIp() },
      });

      // A signed-in browser must never be bounced to an attacker's origin.
      const location = String(response.headers['location'] ?? '');
      expect(location.startsWith('https://evil.example.com')).toBe(false);
    });

    it('refuses an off-site redirectTo when the link is issued through the API', async () => {
      const response = await built.app.inject({
        method: 'POST',
        url: '/auth/magic-link',
        headers: { 'x-forwarded-for': nextIp() },
        payload: { email: 'someone@example.com', redirectTo: 'https://evil.example.com/harvest' },
      });

      // Either rejected outright, or stored normalised — never stored verbatim.
      if (response.statusCode === 202) {
        const rows = await built.services.db.primary
          .select({ redirectTo: magicLinks.redirectTo })
          .from(magicLinks)
          .where(eq(magicLinks.email, 'someone@example.com'))
          .orderBy(sql`created_at desc`)
          .limit(1);
        expect(rows[0]?.redirectTo ?? '').not.toContain('evil.example.com');
      } else {
        expect(response.statusCode).toBe(400);
      }
    });
  });

  // ------------------------------------------------------------------ #3
  describe('TOTP replay and challenge brute force', () => {
    /**
     * Promotes to instructor, which §8 makes an MFA-required role. Enrolment
     * spends the *previous* counter so the test's own code is untouched — a code
     * may legitimately only be spent once, which is the property under test.
     */
    async function makeInstructor(session: Session, secret: string): Promise<void> {
      const confirm = await built.app.inject({
        method: 'POST',
        url: '/auth/mfa/totp/confirm',
        headers: headersFor(session),
        payload: { code: codeFor(secret, -1) },
      });
      expect(confirm.statusCode).toBe(200);
      await built.services.db.primary
        .update(users)
        .set({ role: 'instructor' })
        .where(eq(users.id, session.userId));
    }

    async function challengeFor(session: Session): Promise<string> {
      const login = await built.app.inject({
        method: 'POST',
        url: '/auth/login',
        headers: { 'x-forwarded-for': nextIp() },
        payload: { email: session.email, password: 'correct-horse-battery-staple' },
      });
      expect(login.statusCode).toBe(200);
      const body = login.json() as { mfaRequired: boolean; challengeId?: string };
      expect(body.mfaRequired).toBe(true);
      return body.challengeId as string;
    }

    it('refuses a TOTP code that has already been used', async () => {
      const session = await register('replay');
      const secret = await enrolTotp(session);
      await makeInstructor(session, secret);

      const code = codeFor(secret);

      const first = await built.app.inject({
        method: 'POST',
        url: '/auth/mfa/challenge',
        headers: { 'x-forwarded-for': nextIp() },
        payload: { challengeId: await challengeFor(session), code },
      });
      expect(first.statusCode).toBe(200);

      // Same code, fresh challenge: a captured code must not mint a second
      // session inside its 90-second acceptance window.
      const replay = await built.app.inject({
        method: 'POST',
        url: '/auth/mfa/challenge',
        headers: { 'x-forwarded-for': nextIp() },
        payload: { challengeId: await challengeFor(session), code },
      });
      expect(replay.statusCode).toBe(401);
    });

    it('burns the challenge after a wrong code rather than allowing unlimited guesses', async () => {
      const session = await register('brute');
      const secret = await enrolTotp(session);
      await makeInstructor(session, secret);

      const challengeId = await challengeFor(session);

      for (let attempt = 0; attempt < 5; attempt += 1) {
        const wrong = await built.app.inject({
          method: 'POST',
          url: '/auth/mfa/challenge',
          headers: { 'x-forwarded-for': nextIp() },
          payload: { challengeId, code: String(100000 + attempt) },
        });
        expect(wrong.statusCode).toBe(401);
      }

      // A challenge that survives five wrong codes survives a million.
      const good = await built.app.inject({
        method: 'POST',
        url: '/auth/mfa/challenge',
        headers: { 'x-forwarded-for': nextIp() },
        payload: { challengeId, code: codeFor(secret, 0) },
      });
      expect(good.statusCode).toBe(401);
    });
  });

  // ------------------------------------------------------------------ #4
  describe('MFA secret storage', () => {
    it('stores the TOTP seed encrypted, never in plaintext', async () => {
      const session = await register('atrest');
      const secret = await enrolTotp(session);

      const rows = await built.services.db.primary
        .select({ secret: mfaMethods.secret })
        .from(mfaMethods)
        .where(eq(mfaMethods.userId, session.userId));

      const totp = rows.map((r) => r.secret).find((value) => value.startsWith('v1.'));
      expect(totp, 'no encrypted TOTP envelope found').toBeTruthy();
      expect(totp).not.toContain(secret);
      expect(decryptSecret(env.MFA_ENCRYPTION_KEY, totp as string)).toBe(secret);

      // Recovery codes are Argon2id digests, not plaintext.
      const recovery = rows.map((r) => r.secret).filter((value) => value.startsWith('$argon2id$'));
      expect(recovery.length).toBe(10);
    });
  });

  // ------------------------------------------------------------------ #5
  describe('cookies', () => {
    it('marks the session cookie HttpOnly and the CSRF cookie readable', async () => {
      const response = await built.app.inject({
        method: 'POST',
        url: '/auth/register',
        headers: { 'x-forwarded-for': nextIp() },
        payload: {
          email: `sec-cookie-${Date.now()}@example.com`,
          password: 'correct-horse-battery-staple',
          displayName: 'Cookie Review',
        },
      });
      const raw = response.headers['set-cookie'];
      const jar = Array.isArray(raw) ? raw : [String(raw)];

      const sessionCookie = jar.find((c) => c.startsWith(`${env.SESSION_COOKIE_NAME}=`)) as string;
      const csrfCookie = jar.find((c) => c.startsWith(`${env.CSRF_COOKIE_NAME}=`)) as string;

      expect(sessionCookie.toLowerCase()).toContain('httponly');
      expect(sessionCookie.toLowerCase()).toContain('samesite=lax');
      expect(sessionCookie.toLowerCase()).toContain('path=/');
      // Double submit requires the SPA to read this one.
      expect(csrfCookie.toLowerCase()).not.toContain('httponly');
    });
  });

  // ------------------------------------------------------------------ #6
  describe('CSRF double submit', () => {
    it('rejects a self-consistent token forged for another session', async () => {
      const victim = await register('csrf-victim');
      const attacker = await register('csrf-attacker');

      // The attacker's own cookie pair is internally consistent, but its HMAC
      // binds it to the attacker's session, not the victim's.
      const response = await built.app.inject({
        method: 'DELETE',
        url: '/auth/sessions',
        headers: {
          cookie: `${env.SESSION_COOKIE_NAME}=${victim.sessionToken}; ${env.CSRF_COOKIE_NAME}=${attacker.csrf}`,
          'x-csrf-token': attacker.csrf,
          'x-forwarded-for': nextIp(),
        },
      });
      expect(response.statusCode).toBe(403);
    });

    /**
     * Login CSRF. `/auth` registers a form-encoded parser for the SAML binding,
     * which makes a cross-site form POST to `/auth/login` a *simple* request:
     * no preflight, so the CORS allowlist never gets a vote. If it is accepted,
     * an attacker silently signs the victim's browser into an account the
     * attacker controls and then reads everything the victim does in it.
     */
    it('rejects a cross-origin form POST to /auth/login', async () => {
      const response = await built.app.inject({
        method: 'POST',
        url: '/auth/login',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          origin: 'https://evil.example.com',
          'x-forwarded-for': nextIp(),
        },
        payload: new URLSearchParams({
          email: 'attacker@example.com',
          password: 'correct-horse-battery-staple',
        }).toString(),
      });
      expect(response.statusCode).toBe(403);
      expect(String(response.headers['set-cookie'] ?? '')).not.toContain(
        `${env.SESSION_COOKIE_NAME}=`,
      );
    });

    it('rejects a cross-origin POST even when the CSRF pair is self-consistent', async () => {
      const victim = await register('csrf-origin');
      const response = await built.app.inject({
        method: 'DELETE',
        url: '/auth/sessions',
        headers: {
          cookie: victim.cookie,
          'x-csrf-token': victim.csrf,
          origin: 'https://evil.example.com',
          'x-forwarded-for': nextIp(),
        },
      });
      expect(response.statusCode).toBe(403);
    });

    it('still accepts a same-origin request that carries the allowed Origin', async () => {
      const victim = await register('csrf-sameorigin');
      const response = await built.app.inject({
        method: 'DELETE',
        url: '/auth/sessions',
        headers: {
          cookie: victim.cookie,
          'x-csrf-token': victim.csrf,
          origin: env.CORS_ALLOWED_ORIGINS[0] as string,
          'x-forwarded-for': nextIp(),
        },
      });
      expect(response.statusCode).toBe(200);
    });

    it('rejects a state-changing request that carries no CSRF header', async () => {
      const victim = await register('csrf-missing');
      const response = await built.app.inject({
        method: 'DELETE',
        url: '/auth/sessions',
        headers: {
          cookie: `${env.SESSION_COOKIE_NAME}=${victim.sessionToken}`,
          'x-forwarded-for': nextIp(),
        },
      });
      expect(response.statusCode).toBe(403);
    });
  });
});
