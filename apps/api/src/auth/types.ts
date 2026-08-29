import type { Entitlements, PlanCode } from '../entitlements/index.js';

export type UserRole = 'learner' | 'instructor' | 'org_admin' | 'admin';
export type OrgRole = 'member' | 'instructor' | 'admin';

/** RFC 8176-flavoured authentication method references. */
export type Amr = 'pwd' | 'otp' | 'webauthn' | 'oidc' | 'saml' | 'link' | 'recovery';

export interface SessionRecord {
  userId: string;
  email: string;
  handle: string;
  role: UserRole;
  orgId: string | null;
  orgRole: OrgRole | null;
  amr: Amr[];
  mfaSatisfied: boolean;
  /** Mirrors `identity.users.privilege_version`; a bump invalidates the session. */
  privilegeVersion: number;
  plan: PlanCode;
  entitlements: Entitlements;
  /** Stamp of the entitlement snapshot cached above. */
  entitlementStamp: string;
  ipHash: string | null;
  uaHash: string | null;
  createdAtMs: number;
  expiresAtMs: number;
}

/** What `request.auth` carries once a session has been resolved. */
export interface AuthContext extends SessionRecord {
  /** SHA-256 of the presented token; the Redis and Postgres key. */
  sessionKey: string;
  /**
   * Scopes from an internal service token, when that is what authenticated the
   * request. `undefined` for a human session. `requireServiceToken` checks it,
   * so a token minted to report a lab result cannot also settle a contest.
   */
  serviceScope?: readonly string[];
}

/** §8: MFA is required for these roles. */
export const MFA_REQUIRED_ROLES: readonly UserRole[] = ['instructor', 'org_admin', 'admin'];

export function roleRequiresMfa(role: UserRole): boolean {
  return MFA_REQUIRED_ROLES.includes(role);
}
