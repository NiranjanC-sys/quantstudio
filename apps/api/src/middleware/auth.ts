/**
 * Session resolution and authorisation guards.
 *
 * Three credentials are accepted, in this order:
 *   1. the session cookie (§8) — the browser path;
 *   2. `Authorization: Bearer rq_…` — a user API key;
 *   3. `Authorization: Bearer <EdDSA JWT>` — an internal service token (§8),
 *      which may act on behalf of a user but never carries a session.
 *
 * The entitlement snapshot cached in the session is checked against a Redis
 * stamp on every request; a plan change therefore takes effect on the user's
 * next request without a Postgres read on the hot path (§7).
 */
import { and, eq, isNull, or, sql } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import { apiKeys, orgMembers, users } from '../db/schema/identity.js';
import { ApiError, problem } from '../errors.js';
import { entitlementsFor, freeSubscription } from '../entitlements/index.js';
import { sha256Hex } from '../lib/crypto.js';
import type { AuthContext, OrgRole, UserRole } from '../auth/types.js';
import { roleRequiresMfa } from '../auth/types.js';

const API_KEY_PREFIX = 'rq_';

export const authPlugin = fp(async (app: FastifyInstance) => {
  const { env, db, sessions, entitlements: entitlementService, serviceTokens } = app.services;

  app.decorateRequest('auth', null);
  app.decorateRequest('entitlements', null);
  app.decorateRequest('idempotency', null);

  async function fromApiKey(request: FastifyRequest, token: string): Promise<AuthContext | null> {
    const rows = await db.replica
      .select({
        keyId: apiKeys.id,
        userId: apiKeys.userId,
        orgId: apiKeys.orgId,
        scopes: apiKeys.scopes,
        email: users.email,
        handle: users.handle,
        role: users.role,
        status: users.status,
        privilegeVersion: users.privilegeVersion,
        userOrgId: users.orgId,
      })
      .from(apiKeys)
      .innerJoin(users, eq(users.id, apiKeys.userId))
      .where(
        and(
          eq(apiKeys.keyHash, sha256Hex(token)),
          isNull(apiKeys.revokedAt),
          or(isNull(apiKeys.expiresAt), sql`${apiKeys.expiresAt} > now()`),
        ),
      )
      .limit(1);

    const row = rows[0];
    if (!row || row.status !== 'active') return null;

    const resolved = await entitlementService.resolve(row.userId);

    // Touch asynchronously: an API key's last-used timestamp is not worth
    // adding a write to the critical path of every call.
    void db.primary
      .update(apiKeys)
      .set({ lastUsedAt: new Date() })
      .where(eq(apiKeys.id, row.keyId))
      .catch(() => undefined);

    return {
      sessionKey: `apikey:${row.keyId}`,
      userId: row.userId,
      email: row.email,
      handle: row.handle,
      role: row.role as UserRole,
      orgId: row.orgId ?? row.userOrgId,
      orgRole: null,
      amr: [],
      // An API key cannot satisfy MFA, so key-authenticated callers are blocked
      // from routes that require it.
      mfaSatisfied: false,
      privilegeVersion: row.privilegeVersion,
      plan: resolved.entitlements.plan,
      entitlements: resolved.entitlements,
      entitlementStamp: resolved.stamp,
      ipHash: request.clientIpHash,
      uaHash: null,
      createdAtMs: Date.now(),
      expiresAtMs: Date.now() + 60_000,
    };
  }

  async function fromServiceToken(
    request: FastifyRequest,
    token: string,
  ): Promise<AuthContext | null> {
    // Exactly one audience, and not one of the outbound ones. Trying each of
    // `SERVICE_JWT_AUDIENCE` in turn made the gateway a confused deputy: the
    // token minted in `routes/tutor.ts` for the `ai-tutor` audience carries the
    // *end user* as `sub` and is sent to a third-party service, so anyone who
    // read it there could present it here and be that user for five minutes.
    {
      try {
        const claims = await serviceTokens.verify(
          token,
          env.SERVICE_JWT_INBOUND_AUDIENCE,
        );
        if (!claims.sub) return null;

        const rows = await db.replica
          .select({
            id: users.id,
            email: users.email,
            handle: users.handle,
            role: users.role,
            orgId: users.orgId,
            privilegeVersion: users.privilegeVersion,
            status: users.status,
          })
          .from(users)
          .where(eq(users.id, claims.sub))
          .limit(1);

        const row = rows[0];
        if (!row || row.status !== 'active') return null;

        const resolved = await entitlementService.resolve(row.id);

        return {
          sessionKey: `svc:${claims.jti ?? 'unknown'}`,
          userId: row.id,
          email: row.email,
          handle: row.handle,
          role: row.role as UserRole,
          orgId: row.orgId,
          orgRole: null,
          amr: [],
          // A service token is not a second factor. Nothing that calls
          // `requireServiceToken` checks MFA, and claiming it was satisfied
          // would let one of these reach an MFA-gated human endpoint.
          mfaSatisfied: false,
          serviceScope: Array.isArray(claims.scope) ? claims.scope : [],
          privilegeVersion: row.privilegeVersion,
          plan: resolved.entitlements.plan,
          entitlements: resolved.entitlements,
          entitlementStamp: resolved.stamp,
          ipHash: request.clientIpHash,
          uaHash: null,
          createdAtMs: Date.now(),
          expiresAtMs: Date.now() + env.SERVICE_JWT_TTL_SECONDS * 1000,
        };
      } catch {
        return null;
      }
    }
  }

  app.addHook('preHandler', async (request: FastifyRequest) => {
    const cookieToken = request.cookies[env.SESSION_COOKIE_NAME];

    if (cookieToken) {
      const auth = await sessions.resolve(cookieToken);
      if (auth) {
        // Cheap staleness check: one Redis GET, no Postgres.
        const stamp = await entitlementService.stamp(auth.userId);
        if (stamp !== auth.entitlementStamp) {
          const refreshed = await entitlementService.resolve(auth.userId);
          auth.entitlements = refreshed.entitlements;
          auth.entitlementStamp = refreshed.stamp;
          auth.plan = refreshed.entitlements.plan;
          await sessions.patch(auth.sessionKey, {
            entitlements: refreshed.entitlements,
            entitlementStamp: refreshed.stamp,
            plan: refreshed.entitlements.plan,
          });
        }
        request.auth = auth;
        request.entitlements = auth.entitlements;
        return;
      }
    }

    const header = request.headers.authorization;
    if (typeof header === 'string' && header.startsWith('Bearer ')) {
      const token = header.slice('Bearer '.length).trim();
      const auth = token.startsWith(API_KEY_PREFIX)
        ? await fromApiKey(request, token)
        : await fromServiceToken(request, token);
      if (auth) {
        request.auth = auth;
        request.entitlements = auth.entitlements;
        return;
      }
    }

    request.auth = null;
    // Anonymous callers still get an entitlement view, so catalogue gating and
    // simulation limits work without a branch at every call site.
    request.entitlements = entitlementsFor(freeSubscription());
  });

  app.decorate('requireAuth', (request: FastifyRequest): AuthContext => {
    if (!request.auth) throw problem.unauthorized();
    return request.auth;
  });
});

/** Throws unless the caller holds one of `roles`. */
export function requireRole(request: FastifyRequest, ...roles: UserRole[]): AuthContext {
  const auth = request.auth;
  if (!auth) throw problem.unauthorized();
  if (!roles.includes(auth.role)) {
    throw problem.forbidden(`This endpoint requires one of: ${roles.join(', ')}.`);
  }
  // §8: MFA is required for instructor and org_admin. Enforced at use, not only
  // at login, so an old session cannot outlive a role promotion.
  if (roleRequiresMfa(auth.role) && !auth.mfaSatisfied) {
    throw problem.mfaRequired();
  }
  return auth;
}

/** Throws unless the caller holds `role` (or better) inside `orgId`. */
export function requireOrgRole(
  auth: AuthContext,
  orgId: string,
  minimum: OrgRole,
): void {
  if (auth.role === 'admin') return;
  if (auth.orgId !== orgId) {
    throw problem.forbidden('You are not a member of this organisation.');
  }
  const ranking: Record<OrgRole, number> = { member: 0, instructor: 1, admin: 2 };
  const held = auth.orgRole ?? (auth.role === 'org_admin' ? 'admin' : 'member');
  if (ranking[held] < ranking[minimum]) {
    throw problem.forbidden(`This endpoint requires the ${minimum} role in the organisation.`);
  }
}

/** Loads the caller's org membership when a route needs the fine-grained role. */
export async function loadOrgRole(
  app: FastifyInstance,
  userId: string,
  orgId: string,
): Promise<OrgRole | null> {
  const rows = await app.services.db.replica
    .select({ role: orgMembers.role })
    .from(orgMembers)
    .where(and(eq(orgMembers.userId, userId), eq(orgMembers.orgId, orgId)))
    .limit(1);
  return (rows[0]?.role as OrgRole | undefined) ?? null;
}

export function assertMfaSatisfied(auth: AuthContext): void {
  if (!auth.mfaSatisfied) throw new ApiError('mfa-required', 'Re-authenticate with MFA to continue.');
}
