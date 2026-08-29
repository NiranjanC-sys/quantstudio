/**
 * Identity endpoints (system-design §8).
 *
 * Everything here funnels into one place — `establishSession` — because a
 * session is the only thing that carries authority in this system, and there
 * must be exactly one function that decides what goes into one. The federated
 * flows (OIDC, SAML, passkeys, magic links) differ only in how they arrive at a
 * `userId` and an `amr`.
 *
 * MFA is enforced for the roles §8 names: an instructor or org_admin who has
 * enrolled a factor does not get a session from a password alone, they get a
 * challenge id and have to complete the second step.
 */
import { and, eq, isNull, sql } from 'drizzle-orm';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { clearSessionCookie, setSessionCookie } from '../auth/cookies.js';
import type { OidcProviderId } from '../auth/oidc.js';
import { roleRequiresMfa, type Amr, type OrgRole, type UserRole } from '../auth/types.js';
import {
  DEFAULT_TOTP,
  generateRecoveryCodes,
  generateTotpSecret,
  totpUri,
  verifyTotp,
} from '../auth/totp.js';
import type { Queryable } from '../db/client.js';
import {
  accounts,
  authEvents,
  mfaMethods,
  orgMembers,
  orgs,
  users,
} from '../db/schema/identity.js';
import { ApiError, problem } from '../errors.js';
import { entitlementsFor, freeSubscription, ssoAllowed } from '../entitlements/index.js';
import { loadSubscriptionState } from '../entitlements/service.js';
import { decryptSecret, encryptSecret, generateOpaqueToken } from '../lib/crypto.js';
import { validatePassword } from '../auth/password.js';
import { authed, rateLimit, readBody, readParams, readQuery, useIdempotency } from './helpers.js';

/** Login step-up challenges. Short-lived, single-use, Redis-only. */
const mfaChallengeKey = (id: string): string => `mfa:chal:${id}`;
const MFA_CHALLENGE_TTL_SECONDS = 300;

/**
 * A step-up challenge is burned after this many wrong codes. Without a ceiling
 * the challenge is a 300-second window in which a six-digit code can be guessed
 * as often as the per-IP bucket allows, which a botnet turns into a certainty.
 */
const MFA_CHALLENGE_MAX_ATTEMPTS = 5;

/**
 * Replay cache for TOTP codes. RFC 6238 §5.2: "the verifier MUST NOT accept the
 * second attempt of the OTP after the successful validation". `verifyTotp`
 * returns the counter that matched precisely so the caller can spend it; this is
 * where it is spent. Two extra periods of TTL covers the whole skew window.
 */
const totpUsedKey = (methodId: string, counter: number): string =>
  `mfa:totp:used:${methodId}:${counter}`;
const TOTP_REPLAY_TTL_SECONDS =
  DEFAULT_TOTP.periodSeconds * (DEFAULT_TOTP.window * 2 + 2);

const emailSchema = z.string().trim().toLowerCase().email().max(320);
const handleSchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9_-]{3,32}$/, 'Handle must be 3-32 characters of A-Z, 0-9, _ or -.');

const registerSchema = z.object({
  email: emailSchema,
  password: z.string().min(12).max(256),
  displayName: z.string().trim().min(1).max(120),
  handle: handleSchema.optional(),
});

const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1).max(256),
});

const redirectSchema = z.string().url().max(2048).optional();

const providerSchema = z.object({
  provider: z.enum(['google', 'microsoft', 'github', 'orcid', 'linkedin']),
});

const oauthCallbackSchema = z.object({
  state: z.string().min(8).max(512),
  code: z.string().min(1).max(4096).optional(),
  error: z.string().max(256).optional(),
  error_description: z.string().max(1024).optional(),
});

/**
 * WebAuthn ceremony payloads. Validated structurally here and handed to
 * `@simplewebauthn/server`, which is the thing that actually verifies them —
 * the schema exists so a malformed body is a 400, not a library stack trace.
 */
const webauthnResponseSchema = z.object({
  id: z.string().min(1).max(1024),
  rawId: z.string().min(1).max(1024),
  type: z.literal('public-key'),
  response: z.record(z.unknown()),
  clientExtensionResults: z.record(z.unknown()).optional(),
  authenticatorAttachment: z.enum(['platform', 'cross-platform']).optional(),
});

interface UserRecord {
  id: string;
  email: string;
  handle: string;
  displayName: string;
  role: UserRole;
  status: 'active' | 'suspended' | 'deleted';
  orgId: string | null;
  privilegeVersion: number;
  mfaEnrolled: boolean;
  passwordHash: string | null;
}

const USER_COLUMNS = {
  id: users.id,
  email: users.email,
  handle: users.handle,
  displayName: users.displayName,
  role: users.role,
  status: users.status,
  orgId: users.orgId,
  privilegeVersion: users.privilegeVersion,
  mfaEnrolled: users.mfaEnrolled,
  passwordHash: users.passwordHash,
} as const;

export const authRoutes: FastifyPluginAsync = async (app) => {
  const {
    env,
    db,
    redis,
    sessions,
    entitlements: entitlementService,
    passwords,
    passkeys,
    magicLinks,
    oidc,
    saml,
    limiter,
  } = app.services;

  useIdempotency(app);

  /**
   * SAML's HTTP-POST binding is form-encoded. Parsing it here rather than
   * globally keeps every other route JSON-only, which is what lets the CSP and
   * the content-type check stay strict.
   */
  app.addContentTypeParser(
    'application/x-www-form-urlencoded',
    { parseAs: 'string' },
    (_request, body, done) => {
      try {
        done(null, Object.fromEntries(new URLSearchParams(body as string)));
      } catch (error) {
        done(error instanceof Error ? error : new Error('Malformed form body'), undefined);
      }
    },
  );

  const authLimit = rateLimit(app, 'auth', {
    keyBy: (request) => `ip:${request.clientIpHash ?? 'unknown'}`,
  });

  /**
   * Every sign-in flow ends in a browser redirect whose target arrives from the
   * caller. An unchecked target is an open redirect: it turns the gateway into a
   * credible-looking hop into a phishing page, arriving immediately after the
   * user has been told they signed in successfully. Only our own origins — and
   * relative paths, which are ours by construction — survive this.
   */
  function safeRedirect(candidate: string | null | undefined): string {
    const fallback = env.WEB_PUBLIC_URL;
    if (!candidate) return fallback;

    // `//evil.example` is protocol-relative, not a path.
    if (candidate.startsWith('/') && !candidate.startsWith('//')) {
      return new URL(candidate, env.WEB_PUBLIC_URL).href;
    }

    let parsed: URL;
    try {
      parsed = new URL(candidate);
    } catch {
      return fallback;
    }

    const allowed = new Set<string>([
      new URL(env.WEB_PUBLIC_URL).origin,
      new URL(env.API_PUBLIC_URL).origin,
      ...env.CORS_ALLOWED_ORIGINS,
    ]);
    return allowed.has(parsed.origin) ? parsed.href : fallback;
  }

  /**
   * Spends the counter a TOTP code matched. Returns false when the same code has
   * already been accepted, which is what makes a shoulder-surfed or phished code
   * useless for the remainder of its 90-second window.
   */
  async function claimTotpCounter(methodId: string, counter: number): Promise<boolean> {
    const fresh = await redis.client.set(
      totpUsedKey(methodId, counter),
      '1',
      'EX',
      TOTP_REPLAY_TTL_SECONDS,
      'NX',
    );
    return fresh === 'OK';
  }

  async function record(
    userId: string | null,
    kind: string,
    succeeded: boolean,
    request: FastifyRequest,
    detail?: Record<string, string | number | boolean>,
  ): Promise<void> {
    await db.primary
      .insert(authEvents)
      .values({
        userId,
        kind,
        succeeded,
        ipHash: request.clientIpHash,
        detail: detail ?? null,
      })
      .catch(() => undefined);
  }

  async function loadUserById(handle: Queryable, id: string): Promise<UserRecord | null> {
    const rows = await handle.select(USER_COLUMNS).from(users).where(eq(users.id, id)).limit(1);
    return (rows[0] as UserRecord | undefined) ?? null;
  }

  async function loadUserByEmail(email: string): Promise<UserRecord | null> {
    const rows = await db.primary
      .select(USER_COLUMNS)
      .from(users)
      .where(and(sql`lower(${users.email}) = ${email}`, isNull(users.deletedAt)))
      .limit(1);
    return (rows[0] as UserRecord | undefined) ?? null;
  }

  async function orgRoleFor(userId: string, orgId: string | null): Promise<OrgRole | null> {
    if (!orgId) return null;
    const rows = await db.primary
      .select({ role: orgMembers.role })
      .from(orgMembers)
      .where(and(eq(orgMembers.userId, userId), eq(orgMembers.orgId, orgId)))
      .limit(1);
    return (rows[0]?.role as OrgRole | undefined) ?? null;
  }

  /** §8 org resolution: a verified email domain routes a learner to its org. */
  async function orgForEmailDomain(email: string): Promise<{ id: string } | null> {
    const domain = email.split('@')[1]?.toLowerCase();
    if (!domain) return null;
    const rows = await db.primary
      .select({ id: orgs.id })
      .from(orgs)
      .where(and(eq(orgs.emailDomain, domain), eq(orgs.domainVerified, true)))
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * The single place a session is minted. Everything else in this file exists to
   * work out `userId` and `amr`; this decides what authority that carries.
   */
  async function establishSession(
    request: FastifyRequest,
    reply: FastifyReply,
    user: UserRecord,
    amr: Amr[],
    mfaSatisfied: boolean,
  ): Promise<{ userId: string; role: UserRole; mfaSatisfied: boolean }> {
    // §8, session fixation: the identifier the browser arrived with never
    // survives an authentication. A fresh one is minted below; the presented one
    // is destroyed rather than left alive in Redis with its cookie overwritten.
    const presented = request.cookies[env.SESSION_COOKIE_NAME];
    if (presented) {
      await sessions.destroy(presented, 'superseded_by_login').catch(() => undefined);
    }

    const resolved = await entitlementService.resolve(user.id);
    const issued = await sessions.create({
      userId: user.id,
      email: user.email,
      handle: user.handle,
      role: user.role,
      orgId: user.orgId,
      orgRole: await orgRoleFor(user.id, user.orgId),
      amr,
      mfaSatisfied,
      privilegeVersion: user.privilegeVersion,
      plan: resolved.entitlements.plan,
      entitlements: resolved.entitlements,
      entitlementStamp: resolved.stamp,
      ipHash: request.clientIpHash,
      uaHash: null,
    });

    setSessionCookie(env, reply, issued.token);
    await db.primary
      .update(users)
      .set({ lastLoginAt: new Date() })
      .where(eq(users.id, user.id))
      .catch(() => undefined);

    return { userId: user.id, role: user.role, mfaSatisfied };
  }

  /**
   * A user with an enrolled factor and a role §8 requires MFA for does not get a
   * session from the first factor alone.
   */
  async function needsSecondFactor(user: UserRecord): Promise<boolean> {
    if (!user.mfaEnrolled) return false;
    const confirmed = await db.primary
      .select({ id: mfaMethods.id })
      .from(mfaMethods)
      .where(
        and(
          eq(mfaMethods.userId, user.id),
          eq(mfaMethods.kind, 'totp'),
          sql`${mfaMethods.confirmedAt} is not null`,
        ),
      )
      .limit(1);
    return confirmed.length > 0;
  }

  async function issueMfaChallenge(user: UserRecord, amr: Amr[]): Promise<string> {
    const challengeId = generateOpaqueToken(24);
    await redis.client.set(
      mfaChallengeKey(challengeId),
      JSON.stringify({ userId: user.id, amr }),
      'EX',
      MFA_CHALLENGE_TTL_SECONDS,
    );
    return challengeId;
  }

  /** Derives a unique handle from an email local part, for federated signups. */
  async function allocateHandle(seed: string): Promise<string> {
    const base = seed.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 24) || 'learner';
    const padded = base.length >= 3 ? base : `${base}user`;
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const candidate = attempt === 0 ? padded : `${padded}-${generateOpaqueToken(3).slice(0, 5)}`;
      const clash = await db.primary
        .select({ id: users.id })
        .from(users)
        .where(sql`lower(${users.handle}) = ${candidate.toLowerCase()}`)
        .limit(1);
      if (clash.length === 0) return candidate;
    }
    throw new ApiError('conflict', 'Could not allocate a unique handle; please choose one.');
  }

  /**
   * Creates a user and every per-user row the rest of the product assumes
   * exists, in one transaction. `provisionNewUser` writes the mastery row, the
   * streak row, the credit balance and the entitlement snapshot (§7).
   */
  async function createUser(input: {
    email: string;
    displayName: string;
    handle: string;
    passwordHash: string | null;
    emailVerified: boolean;
    orgId: string | null;
    avatarUrl?: string | null;
  }): Promise<UserRecord> {
    return db.primary.transaction(async (tx) => {
      const inserted = await tx
        .insert(users)
        .values({
          email: input.email,
          emailVerified: input.emailVerified,
          displayName: input.displayName,
          handle: input.handle,
          passwordHash: input.passwordHash,
          orgId: input.orgId,
          avatarUrl: input.avatarUrl ?? null,
        })
        .returning(USER_COLUMNS);

      const user = inserted[0] as UserRecord | undefined;
      if (!user) throw problem.internal('User insert returned no row.');

      if (input.orgId) {
        await tx
          .insert(orgMembers)
          .values({ orgId: input.orgId, userId: user.id, role: 'member' })
          .onConflictDoNothing();
      }

      await entitlementService.provisionNewUser(tx, user.id);
      return user;
    });
  }

  /**
   * §7's SSO row is per plan. The plan that governs a federated sign-in is the
   * one the resulting account will hold: an existing user's own plan, or — for a
   * brand new account — the plan of the organisation that owns their verified
   * email domain, else Free.
   */
  async function assertProviderAllowed(
    provider: OidcProviderId,
    user: UserRecord | null,
    email: string | null,
  ): Promise<void> {
    let entitlements = entitlementsFor(freeSubscription());

    if (user) {
      entitlements = (await entitlementService.resolve(user.id)).entitlements;
    } else if (email) {
      const org = await orgForEmailDomain(email);
      if (org) {
        const orgMemberRows = await db.primary
          .select({ userId: orgMembers.userId })
          .from(orgMembers)
          .where(eq(orgMembers.orgId, org.id))
          .limit(1);
        const anchor = orgMemberRows[0]?.userId;
        if (anchor) {
          entitlements = entitlementsFor(await loadSubscriptionState(db.primary, anchor));
        }
      }
    }

    if (!ssoAllowed(entitlements, provider)) {
      throw new ApiError(
        'entitlement-required',
        `Signing in with ${provider} is not included in the ${entitlements.plan} plan.`,
        { extensions: { feature: 'sso', provider, currentPlan: entitlements.plan } },
      );
    }
  }

  // ---------------------------------------------------------------- providers

  app.get('/providers', async (_request, reply) => {
    return reply.send({
      oidc: oidc.configured(),
      passwords: true,
      passkeys: true,
      magicLink: true,
      saml: true,
    });
  });

  // ------------------------------------------------------- password lifecycle

  app.post('/register', { preHandler: [authLimit] }, async (request, reply) => {
    const input = readBody(request, registerSchema);

    const issues = validatePassword(input.password);
    if (issues.length > 0) {
      throw new ApiError('validation-failed', 'Password does not meet the policy.', {
        extensions: { issues },
      });
    }

    const existing = await loadUserByEmail(input.email);
    if (existing) {
      await record(null, 'register', false, request, { reason: 'email_taken' });
      // Deliberately the same shape as a real conflict: enumeration of who has
      // an account is not worth the marginally better error message.
      throw new ApiError('conflict', 'An account with that email already exists.');
    }

    const handle = input.handle
      ? input.handle
      : await allocateHandle(input.email.split('@')[0] ?? 'learner');

    if (input.handle) {
      const clash = await db.primary
        .select({ id: users.id })
        .from(users)
        .where(sql`lower(${users.handle}) = ${handle.toLowerCase()}`)
        .limit(1);
      if (clash.length > 0) throw new ApiError('conflict', 'That handle is already taken.');
    }

    const org = await orgForEmailDomain(input.email);

    const user = await createUser({
      email: input.email,
      displayName: input.displayName,
      handle,
      passwordHash: await passwords.hash(input.password),
      emailVerified: false,
      orgId: org?.id ?? null,
    });

    await record(user.id, 'register', true, request);
    const session = await establishSession(request, reply, user, ['pwd'], false);

    return reply.status(201).send({
      user: {
        id: user.id,
        email: user.email,
        handle: user.handle,
        displayName: user.displayName,
        role: user.role,
        orgId: user.orgId,
      },
      session,
    });
  });

  app.post('/login', { preHandler: [authLimit] }, async (request, reply) => {
    const input = readBody(request, loginSchema);
    const ipHash = request.clientIpHash ?? 'unknown';

    // §9: exponential backoff on failure, keyed by IP.
    const backoff = await limiter.authBackoffRemainingSeconds(ipHash);
    if (backoff > 0) {
      throw new ApiError('rate-limited', 'Too many failed sign-in attempts from this network.', {
        retryAfterSeconds: backoff,
      });
    }

    const user = await loadUserByEmail(input.email);

    // The password is verified even when the account does not exist, so the
    // response time does not disclose which emails are registered.
    const digest = user?.passwordHash ?? '$argon2id$v=19$m=65536,t=3,p=4$AAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
    const valid = await passwords.verify(digest, input.password);

    if (!user || !valid || user.status !== 'active') {
      await limiter.recordAuthFailure(ipHash);
      await record(user?.id ?? null, 'login', false, request, { method: 'password' });
      throw problem.unauthorized('Email or password is incorrect.');
    }

    await limiter.clearAuthFailures(ipHash);

    if (user.passwordHash && passwords.needsRehash(user.passwordHash)) {
      await db.primary
        .update(users)
        .set({ passwordHash: await passwords.hash(input.password), updatedAt: new Date() })
        .where(eq(users.id, user.id));
    }

    if (roleRequiresMfa(user.role) && (await needsSecondFactor(user))) {
      const challengeId = await issueMfaChallenge(user, ['pwd']);
      await record(user.id, 'login', true, request, { method: 'password', mfa: 'required' });
      return reply.status(200).send({
        mfaRequired: true,
        challengeId,
        methods: ['totp', 'recovery_code'],
        expiresInSeconds: MFA_CHALLENGE_TTL_SECONDS,
      });
    }

    await record(user.id, 'login', true, request, { method: 'password' });
    const session = await establishSession(request, reply, user, ['pwd'], false);
    return reply.send({ mfaRequired: false, session });
  });

  app.post('/logout', async (request, reply) => {
    const token = request.cookies[env.SESSION_COOKIE_NAME];
    if (token) {
      await sessions.destroy(token, 'logout');
      await record(request.auth?.userId ?? null, 'logout', true, request);
    }
    clearSessionCookie(env, reply);
    return reply.status(204).send();
  });

  // ------------------------------------------------------------- the session

  app.get('/session', async (request, reply) => {
    const auth = request.auth;
    if (!auth) return reply.status(200).send({ authenticated: false });

    return reply.send({
      authenticated: true,
      user: {
        id: auth.userId,
        email: auth.email,
        handle: auth.handle,
        role: auth.role,
        orgId: auth.orgId,
        orgRole: auth.orgRole,
      },
      amr: auth.amr,
      mfaSatisfied: auth.mfaSatisfied,
      plan: auth.plan,
      entitlements: auth.entitlements,
      expiresAt: new Date(auth.expiresAtMs).toISOString(),
    });
  });

  app.get('/sessions', async (request, reply) => {
    const auth = authed(request);
    const list = await sessions.listForUser(auth.userId);
    return reply.send({
      items: list.map(({ sessionKey, record: session }) => ({
        id: sessionKey,
        current: sessionKey === auth.sessionKey,
        amr: session.amr,
        mfaSatisfied: session.mfaSatisfied,
        ipHash: session.ipHash,
        createdAt: new Date(session.createdAtMs).toISOString(),
        expiresAt: new Date(session.expiresAtMs).toISOString(),
      })),
    });
  });

  app.delete('/sessions/:sessionKey', async (request, reply) => {
    const auth = authed(request);
    const { sessionKey } = readParams(
      request,
      z.object({ sessionKey: z.string().min(16).max(128) }),
    );

    const owned = await sessions.listForUser(auth.userId);
    if (!owned.some((entry) => entry.sessionKey === sessionKey)) {
      throw problem.notFound('Session');
    }

    await sessions.destroyByKey(sessionKey, 'user_revoked');
    if (sessionKey === auth.sessionKey) clearSessionCookie(env, reply);
    return reply.status(204).send();
  });

  app.delete('/sessions', async (request, reply) => {
    const auth = authed(request);
    const revoked = await sessions.destroyAllForUser(auth.userId, 'user_revoked_all', auth.sessionKey);
    await record(auth.userId, 'revoke_all_sessions', true, request, { revoked });
    return reply.send({ revoked });
  });

  // --------------------------------------------------------------- magic link

  app.post('/magic-link', { preHandler: [authLimit] }, async (request, reply) => {
    const input = readBody(
      request,
      z.object({ email: emailSchema, redirectTo: redirectSchema }),
    );
    const { expiresAt } = await magicLinks.issue({
      email: input.email,
      redirectTo: safeRedirect(input.redirectTo),
    });
    // Always 202, whether or not the address is registered.
    return reply.status(202).send({ sent: true, expiresAt: expiresAt.toISOString() });
  });

  app.get('/magic-link/callback', { preHandler: [authLimit] }, async (request, reply) => {
    const { token } = readQuery(request, z.object({ token: z.string().min(16).max(512) }));
    const consumed = await magicLinks.consume(token);

    let user = consumed.userId
      ? await loadUserById(db.primary, consumed.userId)
      : await loadUserByEmail(consumed.email);

    if (!user) {
      const org = await orgForEmailDomain(consumed.email);
      user = await createUser({
        email: consumed.email,
        displayName: consumed.email.split('@')[0] ?? 'Learner',
        handle: await allocateHandle(consumed.email.split('@')[0] ?? 'learner'),
        passwordHash: null,
        emailVerified: true,
        orgId: org?.id ?? null,
      });
    }

    if (user.status !== 'active') throw problem.forbidden('This account is not active.');

    // A magic link proves control of the mailbox, so it verifies the address.
    await db.primary
      .update(users)
      .set({ emailVerified: true, updatedAt: new Date() })
      .where(eq(users.id, user.id));

    if (roleRequiresMfa(user.role) && (await needsSecondFactor(user))) {
      const challengeId = await issueMfaChallenge(user, ['link']);
      const url = new URL('/auth/mfa', env.WEB_PUBLIC_URL);
      url.searchParams.set('challenge', challengeId);
      return reply.redirect(url.href, 303);
    }

    await record(user.id, 'login', true, request, { method: 'magic_link' });
    await establishSession(request, reply, user, ['link'], false);
    return reply.redirect(safeRedirect(consumed.redirectTo), 303);
  });

  // -------------------------------------------------------------- OIDC/OAuth

  app.get('/oauth/:provider/start', { preHandler: [authLimit] }, async (request, reply) => {
    const { provider } = readParams(request, providerSchema);
    const { redirectTo, link } = readQuery(
      request,
      z.object({
        redirectTo: redirectSchema,
        link: z
          .enum(['true', 'false'])
          .default('false')
          .transform((value) => value === 'true'),
      }),
    );

    if (!oidc.isConfigured(provider)) {
      throw problem.notFound(`The ${provider} sign-in provider`);
    }

    // Linking an additional provider requires an existing session; signing in
    // does not.
    const linkUserId = link ? authed(request).userId : null;

    const started = await oidc.begin({
      provider,
      redirectTo: safeRedirect(redirectTo),
      linkUserId,
    });

    return reply.redirect(started.url, 302);
  });

  app.get('/oauth/:provider/callback', { preHandler: [authLimit] }, async (request, reply) => {
    const { provider } = readParams(request, providerSchema);
    const query = readQuery(request, oauthCallbackSchema);

    if (query.error) {
      throw problem.unauthorized(
        `${provider} rejected the sign-in: ${query.error_description ?? query.error}`,
      );
    }

    const callbackUrl = new URL(request.url, env.API_PUBLIC_URL);
    const { profile, stateRecord } = await oidc.complete({
      provider,
      callbackUrl,
      state: query.state,
    });

    const linked = await db.primary
      .select({ userId: accounts.userId })
      .from(accounts)
      .where(
        and(
          eq(accounts.provider, provider),
          eq(accounts.providerAccountId, profile.providerAccountId),
        ),
      )
      .limit(1);

    let user: UserRecord | null = linked[0]
      ? await loadUserById(db.primary, linked[0].userId)
      : null;

    if (!user && stateRecord.linkUserId) {
      user = await loadUserById(db.primary, stateRecord.linkUserId);
    }

    // An unlinked provider account whose verified email matches an existing user
    // is attached to that user. An *unverified* email is never trusted to do
    // that: it is exactly how account takeover happens.
    if (!user && profile.email && profile.emailVerified) {
      user = await loadUserByEmail(profile.email.toLowerCase());
    }

    await assertProviderAllowed(provider, user, profile.email?.toLowerCase() ?? null);

    if (!user) {
      if (!profile.email) {
        throw new ApiError(
          'validation-failed',
          `${provider} did not release an email address, which is required to create an account.`,
        );
      }
      const email = profile.email.toLowerCase();
      const org = await orgForEmailDomain(email);
      user = await createUser({
        email,
        displayName: profile.displayName ?? email.split('@')[0] ?? 'Learner',
        handle: await allocateHandle(email.split('@')[0] ?? 'learner'),
        passwordHash: null,
        emailVerified: profile.emailVerified,
        orgId: org?.id ?? null,
        avatarUrl: profile.avatarUrl,
      });
    }

    if (user.status !== 'active') throw problem.forbidden('This account is not active.');

    await db.primary
      .insert(accounts)
      .values({
        userId: user.id,
        provider,
        providerAccountId: profile.providerAccountId,
        email: profile.email,
        lastUsedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [accounts.provider, accounts.providerAccountId],
        set: { lastUsedAt: new Date(), email: profile.email },
      });

    if (roleRequiresMfa(user.role) && (await needsSecondFactor(user))) {
      const challengeId = await issueMfaChallenge(user, ['oidc']);
      const url = new URL('/auth/mfa', env.WEB_PUBLIC_URL);
      url.searchParams.set('challenge', challengeId);
      return reply.redirect(url.href, 303);
    }

    await record(user.id, 'login', true, request, { method: 'oidc', provider });
    await establishSession(request, reply, user, ['oidc'], false);
    return reply.redirect(safeRedirect(stateRecord.redirectTo), 303);
  });

  // ------------------------------------------------------------------- SAML

  const orgSlugSchema = z.object({ org: z.string().regex(/^[a-z0-9][a-z0-9-]{1,62}$/) });

  async function connectionForSlug(slug: string) {
    const rows = await db.primary
      .select({ id: orgs.id })
      .from(orgs)
      .where(eq(orgs.slug, slug))
      .limit(1);
    const org = rows[0];
    if (!org) throw problem.notFound('Organisation');
    const connection = await saml.byOrg(org.id);
    if (!connection) throw problem.notFound('SAML connection for this organisation');
    return connection;
  }

  app.get('/saml/:org/metadata', async (request, reply) => {
    const { org } = readParams(request, orgSlugSchema);
    const connection = await connectionForSlug(org);
    return reply
      .type('application/samlmetadata+xml')
      .send(saml.adapterFor(connection).spMetadata(connection));
  });

  app.get('/saml/:org/login', { preHandler: [authLimit] }, async (request, reply) => {
    const { org } = readParams(request, orgSlugSchema);
    const { redirectTo } = readQuery(request, z.object({ redirectTo: redirectSchema }));
    const connection = await connectionForSlug(org);

    const relayState = generateOpaqueToken(24);
    await redis.client.set(
      `saml:relay:${relayState}`,
      safeRedirect(redirectTo),
      'EX',
      600,
    );

    const { redirectUrl } = await saml.begin(connection, relayState);
    return reply.redirect(redirectUrl, 302);
  });

  app.post('/saml/:org/acs', { preHandler: [authLimit] }, async (request, reply) => {
    const { org } = readParams(request, orgSlugSchema);
    const form = readBody(
      request,
      z.object({
        SAMLResponse: z.string().min(1).max(1_000_000),
        RelayState: z.string().max(512).optional(),
      }),
    );

    const connection = await connectionForSlug(org);
    const profile = await saml.complete({
      connection,
      samlResponse: form.SAMLResponse,
      relayState: form.RelayState ?? null,
    });

    const email = profile.email?.toLowerCase();
    if (!email) {
      throw new ApiError('unauthorized', 'The SAML assertion released no email address.');
    }

    /**
     * A SAML connection is a signing authority, so the only thing keeping one
     * institution's IdP from speaking for another institution's — or a
     * consumer — account is this check. §8 scopes an org to an email domain
     * "verified by DNS TXT"; an assertion is confined to that domain, plus the
     * accounts this org already legitimately owns.
     *
     * Without it, any customer with a working connection can assert
     * `victim@gmail.com` and be handed that account, or pre-create it so a
     * future sign-up lands in their tenant.
     */
    const ownerOrg = await db.primary
      .select({ emailDomain: orgs.emailDomain, domainVerified: orgs.domainVerified })
      .from(orgs)
      .where(eq(orgs.id, connection.orgId))
      .limit(1);

    const claimedDomain = ownerOrg[0]?.domainVerified
      ? (ownerOrg[0].emailDomain?.toLowerCase() ?? null)
      : null;
    const assertedDomain = email.split('@')[1]?.toLowerCase() ?? null;
    const insideOwnDomain = claimedDomain !== null && assertedDomain === claimedDomain;

    // The NameID lookup is scoped to this connection's org: a globally unique
    // `(provider, provider_account_id)` would otherwise let one IdP claim a
    // NameID another IdP had already registered.
    const linked = await db.primary
      .select({ userId: accounts.userId })
      .from(accounts)
      .where(
        and(
          eq(accounts.provider, 'saml'),
          eq(accounts.providerAccountId, profile.nameId),
          eq(accounts.orgId, connection.orgId),
        ),
      )
      .limit(1);

    let user = linked[0] ? await loadUserById(db.primary, linked[0].userId) : null;

    if (!user) {
      const byEmail = await loadUserByEmail(email);
      if (byEmail) {
        // Matching an existing account by email is only safe when this org owns
        // the domain, or the account is already a member of this org.
        if (!insideOwnDomain && byEmail.orgId !== connection.orgId) {
          await record(byEmail.id, 'login', false, request, {
            method: 'saml',
            org,
            reason: 'domain_not_owned',
          });
          throw problem.forbidden(
            'This identity provider is not authorised for that email domain.',
          );
        }
        user = byEmail;
      }
    }

    if (!user) {
      if (!insideOwnDomain) {
        await record(null, 'login', false, request, {
          method: 'saml',
          org,
          reason: 'domain_not_owned',
        });
        throw problem.forbidden(
          'This identity provider is not authorised for that email domain.',
        );
      }
      user = await createUser({
        email,
        displayName: profile.displayName ?? email.split('@')[0] ?? 'Learner',
        handle: await allocateHandle(email.split('@')[0] ?? 'learner'),
        passwordHash: null,
        // The IdP is authoritative for its own verified domain, and only that.
        emailVerified: true,
        orgId: connection.orgId,
      });
    }

    await db.primary
      .insert(accounts)
      .values({
        userId: user.id,
        provider: 'saml',
        providerAccountId: profile.nameId,
        orgId: connection.orgId,
        email,
        lastUsedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [accounts.provider, accounts.providerAccountId],
        set: { lastUsedAt: new Date(), email },
      });

    await db.primary
      .insert(orgMembers)
      .values({ orgId: connection.orgId, userId: user.id, role: connection.defaultRole })
      .onConflictDoNothing();

    // An assertion is a single factor; §8 still wants MFA for privileged roles.
    if (roleRequiresMfa(user.role) && (await needsSecondFactor(user))) {
      const challengeId = await issueMfaChallenge(user, ['saml']);
      const url = new URL('/auth/mfa', env.WEB_PUBLIC_URL);
      url.searchParams.set('challenge', challengeId);
      return reply.redirect(url.href, 303);
    }

    const relay = form.RelayState
      ? await redis.client.getdel(`saml:relay:${form.RelayState}`)
      : null;

    await record(user.id, 'login', true, request, { method: 'saml', org });
    await establishSession(request, reply, user, ['saml'], false);
    return reply.redirect(safeRedirect(relay), 303);
  });

  // --------------------------------------------------------------- passkeys

  app.post('/passkeys/register/options', async (request, reply) => {
    const auth = authed(request);
    const options = await passkeys.beginRegistration({
      userId: auth.userId,
      userName: auth.email,
      userDisplayName: auth.handle,
    });
    return reply.send(options);
  });

  app.post('/passkeys/register/verify', async (request, reply) => {
    const auth = authed(request);
    const input = readBody(
      request,
      z.object({
        response: webauthnResponseSchema,
        label: z.string().trim().max(64).optional(),
      }),
    );

    const result = await passkeys.finishRegistration({
      userId: auth.userId,
      response: input.response as unknown as Parameters<
        typeof passkeys.finishRegistration
      >[0]['response'],
      ...(input.label ? { label: input.label } : {}),
    });

    await record(auth.userId, 'passkey_register', true, request);
    return reply.status(201).send({ credentialId: result.credentialId });
  });

  app.post('/passkeys/login/options', { preHandler: [authLimit] }, async (request, reply) => {
    const input = readBody(request, z.object({ email: emailSchema.optional() }));
    const user = input.email ? await loadUserByEmail(input.email) : null;
    const started = await passkeys.beginAuthentication(
      user ? { userId: user.id } : {},
    );
    return reply.send({ ceremonyId: started.ceremonyId, options: started.options });
  });

  app.post('/passkeys/login/verify', { preHandler: [authLimit] }, async (request, reply) => {
    const input = readBody(
      request,
      z.object({
        ceremonyId: z.string().min(8).max(512),
        response: webauthnResponseSchema,
      }),
    );

    const verified = await passkeys.finishAuthentication({
      ceremonyId: input.ceremonyId,
      response: input.response as unknown as Parameters<
        typeof passkeys.finishAuthentication
      >[0]['response'],
    });

    const user = await loadUserById(db.primary, verified.userId);
    if (!user || user.status !== 'active') {
      throw problem.forbidden('This account is not active.');
    }

    /**
     * A passkey is multi-factor only when the authenticator actually verified
     * the user — possession *plus* a PIN or biometric. `userVerification` is
     * requested as "preferred", so an authenticator is free to skip it, and a
     * silent `mfaSatisfied: true` would hand an instructor session to whoever
     * holds the key. When it was skipped, the §8 roles fall back to the ordinary
     * second-factor challenge.
     */
    if (
      !verified.userVerified &&
      roleRequiresMfa(user.role) &&
      (await needsSecondFactor(user))
    ) {
      const challengeId = await issueMfaChallenge(user, ['webauthn']);
      await record(user.id, 'login', true, request, { method: 'webauthn', mfa: 'required' });
      return reply.status(200).send({
        mfaRequired: true,
        challengeId,
        methods: ['totp', 'recovery_code'],
        expiresInSeconds: MFA_CHALLENGE_TTL_SECONDS,
      });
    }

    await record(user.id, 'login', true, request, {
      method: 'webauthn',
      userVerified: verified.userVerified,
    });
    const session = await establishSession(
      request,
      reply,
      user,
      ['webauthn'],
      verified.userVerified,
    );
    return reply.send({ session });
  });

  app.get('/passkeys', async (request, reply) => {
    const auth = authed(request);
    const items = await passkeys.list(auth.userId);
    return reply.send({
      items: items.map((item) => ({
        id: item.id,
        label: item.label,
        createdAt: item.createdAt.toISOString(),
        lastUsedAt: item.lastUsedAt?.toISOString() ?? null,
      })),
    });
  });

  app.delete('/passkeys/:credentialId', async (request, reply) => {
    const auth = authed(request);
    const { credentialId } = readParams(
      request,
      z.object({ credentialId: z.string().min(1).max(1024) }),
    );
    const removed = await passkeys.remove(auth.userId, credentialId);
    if (!removed) throw problem.notFound('Passkey');
    await record(auth.userId, 'passkey_remove', true, request);
    return reply.status(204).send();
  });

  // -------------------------------------------------------------------- MFA

  app.post('/mfa/totp/enroll', async (request, reply) => {
    const auth = authed(request);
    const secret = generateTotpSecret();

    const recoveryCodes = generateRecoveryCodes();
    const hashed = await Promise.all(recoveryCodes.map((code) => passwords.hash(code)));

    await db.primary.transaction(async (tx) => {
      // Re-enrolment replaces the previous factor rather than accumulating one
      // usable secret per attempt.
      await tx
        .delete(mfaMethods)
        .where(and(eq(mfaMethods.userId, auth.userId), isNull(mfaMethods.confirmedAt)));
      await tx
        .delete(mfaMethods)
        .where(and(eq(mfaMethods.userId, auth.userId), eq(mfaMethods.kind, 'recovery_code')));
      await tx.insert(mfaMethods).values({
        userId: auth.userId,
        kind: 'totp',
        secret: encryptSecret(env.MFA_ENCRYPTION_KEY, secret),
        label: 'Authenticator app',
      });
      await tx.insert(mfaMethods).values(
        hashed.map((digest) => ({
          userId: auth.userId,
          kind: 'recovery_code' as const,
          secret: digest,
          confirmedAt: new Date(),
        })),
      );
    });

    return reply.status(201).send({
      secret,
      uri: totpUri(secret, auth.email),
      digits: DEFAULT_TOTP.digits,
      periodSeconds: DEFAULT_TOTP.periodSeconds,
      recoveryCodes,
    });
  });

  app.post('/mfa/totp/confirm', async (request, reply) => {
    const auth = authed(request);
    const { code } = readBody(request, z.object({ code: z.string().regex(/^\d{6}$/) }));

    const rows = await db.primary
      .select({ id: mfaMethods.id, secret: mfaMethods.secret })
      .from(mfaMethods)
      .where(and(eq(mfaMethods.userId, auth.userId), eq(mfaMethods.kind, 'totp')))
      .limit(1);

    const method = rows[0];
    if (!method) throw problem.notFound('TOTP enrolment');

    const secret = decryptSecret(env.MFA_ENCRYPTION_KEY, method.secret);
    if (!secret) throw problem.internal('Stored TOTP secret could not be decrypted.');

    const attempt = verifyTotp(secret, code);
    if (!attempt.valid || !(await claimTotpCounter(method.id, attempt.counter as number))) {
      await record(auth.userId, 'mfa_confirm', false, request);
      throw problem.unauthorized('That code is not valid.');
    }

    await db.primary.transaction(async (tx) => {
      await tx
        .update(mfaMethods)
        .set({ confirmedAt: new Date() })
        .where(eq(mfaMethods.id, method.id));
      // §8: rotate on privilege change. Enrolling a factor changes what this
      // account can do, so every existing session is invalidated.
      await tx
        .update(users)
        .set({
          mfaEnrolled: true,
          privilegeVersion: sql`${users.privilegeVersion} + 1`,
          updatedAt: new Date(),
        })
        .where(eq(users.id, auth.userId));
    });

    /**
     * §8: rotate on privilege change. This request *is* a privilege change —
     * `mfaSatisfied` goes false → true, which is what unlocks the instructor and
     * org_admin surface — so the identifier is replaced rather than patched in
     * place. Patching would leave a token that was captured before the step-up
     * silently holding the elevated authority.
     */
    const presented = request.cookies[env.SESSION_COOKIE_NAME];
    const rotated = presented
      ? await sessions.rotate(presented, {
          mfaSatisfied: true,
          amr: [...auth.amr, 'otp'],
          privilegeVersion: auth.privilegeVersion + 1,
        })
      : null;

    if (rotated) setSessionCookie(env, reply, rotated.token);

    // Every *other* session the account holds predates the new factor and is
    // invalidated; the one we just minted is the exception.
    await sessions.destroyAllForUser(
      auth.userId,
      'mfa_enrolled',
      rotated?.sessionKey ?? auth.sessionKey,
    );
    await record(auth.userId, 'mfa_confirm', true, request);

    return reply.send({ enrolled: true });
  });

  app.delete('/mfa/totp', async (request, reply) => {
    const auth = authed(request);
    if (roleRequiresMfa(auth.role)) {
      throw problem.forbidden(`MFA is mandatory for the ${auth.role} role and cannot be removed.`);
    }
    await db.primary.transaction(async (tx) => {
      await tx.delete(mfaMethods).where(eq(mfaMethods.userId, auth.userId));
      await tx
        .update(users)
        .set({
          mfaEnrolled: false,
          privilegeVersion: sql`${users.privilegeVersion} + 1`,
          updatedAt: new Date(),
        })
        .where(eq(users.id, auth.userId));
    });
    await record(auth.userId, 'mfa_remove', true, request);
    return reply.status(204).send();
  });

  /** Completes a login that stopped at the second factor. */
  app.post('/mfa/challenge', { preHandler: [authLimit] }, async (request, reply) => {
    const input = readBody(
      request,
      z.object({
        challengeId: z.string().min(8).max(512),
        code: z.string().trim().min(6).max(16),
      }),
    );

    // §9's exponential backoff is recorded by this endpoint on failure; it has
    // to be honoured here too, or the second factor is the one step of the login
    // that a bot may retry freely.
    const ipHash = request.clientIpHash ?? 'unknown';
    const backoff = await limiter.authBackoffRemainingSeconds(ipHash);
    if (backoff > 0) {
      throw new ApiError('rate-limited', 'Too many failed sign-in attempts from this network.', {
        retryAfterSeconds: backoff,
      });
    }

    const raw = await redis.client.get(mfaChallengeKey(input.challengeId));
    if (!raw) throw problem.unauthorized('That challenge has expired. Sign in again.');

    const challenge = JSON.parse(raw) as { userId: string; amr: Amr[]; attempts?: number };
    const user = await loadUserById(db.primary, challenge.userId);
    if (!user || user.status !== 'active') {
      throw problem.forbidden('This account is not active.');
    }

    const methods = await db.primary
      .select({ id: mfaMethods.id, kind: mfaMethods.kind, secret: mfaMethods.secret })
      .from(mfaMethods)
      .where(and(eq(mfaMethods.userId, user.id), isNull(mfaMethods.consumedAt)));

    const totp = methods.find((method) => method.kind === 'totp');
    let satisfiedWith: Amr | null = null;

    if (totp && /^\d{6}$/.test(input.code)) {
      const secret = decryptSecret(env.MFA_ENCRYPTION_KEY, totp.secret);
      const attempt = secret ? verifyTotp(secret, input.code) : null;
      // A code is spent the moment it is accepted: the same six digits must not
      // buy a second session inside the skew window.
      if (attempt?.valid && (await claimTotpCounter(totp.id, attempt.counter as number))) {
        satisfiedWith = 'otp';
      }
    }

    if (!satisfiedWith) {
      // Recovery codes are Argon2id digests; the loop is over at most ten of them.
      for (const method of methods.filter((m) => m.kind === 'recovery_code')) {
        if (await passwords.verify(method.secret, input.code.toUpperCase())) {
          await db.primary
            .update(mfaMethods)
            .set({ consumedAt: new Date() })
            .where(eq(mfaMethods.id, method.id));
          satisfiedWith = 'recovery';
          break;
        }
      }
    }

    if (!satisfiedWith) {
      // A wrong code costs an attempt. A challenge that survived every wrong
      // code would be a 300-second window in which six digits can be guessed
      // exhaustively; burning it after `MFA_CHALLENGE_MAX_ATTEMPTS` leaves room
      // for a typo and nothing else.
      const attempts = (challenge.attempts ?? 0) + 1;
      if (attempts >= MFA_CHALLENGE_MAX_ATTEMPTS) {
        await redis.client.del(mfaChallengeKey(input.challengeId));
      } else {
        // KEEPTTL: the retry budget must not extend the challenge's lifetime.
        await redis.client.set(
          mfaChallengeKey(input.challengeId),
          JSON.stringify({ ...challenge, attempts }),
          'KEEPTTL',
        );
      }

      await limiter.recordAuthFailure(ipHash);
      await record(user.id, 'mfa_challenge', false, request, { attempts });
      throw problem.unauthorized('That code is not valid.');
    }

    // Single-use: a challenge is exchanged for a session exactly once.
    await redis.client.del(mfaChallengeKey(input.challengeId));
    await record(user.id, 'mfa_challenge', true, request, { method: satisfiedWith });

    const session = await establishSession(
      request,
      reply,
      user,
      [...challenge.amr, satisfiedWith],
      true,
    );
    return reply.send({ session });
  });
};
