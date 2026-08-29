/**
 * `identity` schema — system-design §5 / §8.
 *
 * Owns users, federated accounts, sessions (Postgres holds the durable audit
 * record; Redis `sess:{sid}` is the hot read path), organisations and their SSO
 * connections, WebAuthn credentials, magic links, invites and API keys.
 */
import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgSchema,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

export const identity = pgSchema('identity');

export const userRole = identity.enum('user_role', ['learner', 'instructor', 'org_admin', 'admin']);
export const userStatus = identity.enum('user_status', ['active', 'suspended', 'deleted']);
export const orgKind = identity.enum('org_kind', ['team', 'campus']);
export const orgMemberRole = identity.enum('org_member_role', ['member', 'instructor', 'admin']);
export const authProvider = identity.enum('auth_provider', [
  'google',
  'microsoft',
  'github',
  'orcid',
  'linkedin',
  'saml',
]);
export const mfaMethodKind = identity.enum('mfa_method_kind', ['totp', 'webauthn', 'recovery_code']);

/** RFC 5322 is not worth enforcing in SQL; this rejects the obviously invalid. */
const EMAIL_CHECK = sql`position('@' in ${sql.raw('email')}) > 1 and length(email) between 3 and 320`;

export const orgs = identity.table(
  'orgs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    slug: text('slug').notNull(),
    name: text('name').notNull(),
    kind: orgKind('kind').notNull(),
    /** Email-domain claim used for SSO auto-routing (§8, "Org resolution"). */
    emailDomain: text('email_domain'),
    domainVerified: boolean('domain_verified').notNull().default(false),
    /** Value published as a DNS TXT record to prove control of `email_domain`. */
    domainVerificationToken: text('domain_verification_token'),
    seatLimit: integer('seat_limit').notNull().default(0),
    billingEmail: text('billing_email'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('orgs_slug_key').on(t.slug),
    uniqueIndex('orgs_email_domain_key').on(t.emailDomain),
    check('orgs_seat_limit_nonneg', sql`${t.seatLimit} >= 0`),
    check('orgs_slug_shape', sql`${t.slug} ~ '^[a-z0-9][a-z0-9-]{1,62}$'`),
  ],
);

export const users = identity.table(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    email: text('email').notNull(),
    emailVerified: boolean('email_verified').notNull().default(false),
    displayName: text('display_name').notNull(),
    handle: text('handle').notNull(),
    avatarUrl: text('avatar_url'),
    /** Argon2id (m=64 MiB, t=3, p=4). Null for passkey/SSO-only accounts. */
    passwordHash: text('password_hash'),
    role: userRole('role').notNull().default('learner'),
    status: userStatus('status').notNull().default('active'),
    mfaEnrolled: boolean('mfa_enrolled').notNull().default(false),
    /** Bumped whenever a privilege changes; forces session rotation (§8). */
    privilegeVersion: integer('privilege_version').notNull().default(1),
    orgId: uuid('org_id').references(() => orgs.id, { onDelete: 'set null' }),
    locale: text('locale').notNull().default('en'),
    timezone: text('timezone').notNull().default('UTC'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    lastLoginAt: timestamp('last_login_at', { withTimezone: true, mode: 'date' }),
    deletedAt: timestamp('deleted_at', { withTimezone: true, mode: 'date' }),
  },
  (t) => [
    uniqueIndex('users_email_key').on(sql`lower(${t.email})`),
    uniqueIndex('users_handle_key').on(sql`lower(${t.handle})`),
    index('users_org_id_idx').on(t.orgId),
    index('users_role_idx').on(t.role).where(sql`${t.role} <> 'learner'`),
    check('users_email_shape', EMAIL_CHECK),
    check('users_handle_shape', sql`${t.handle} ~ '^[A-Za-z0-9_-]{3,32}$'`),
    check('users_privilege_version_positive', sql`${t.privilegeVersion} >= 1`),
  ],
);

export const orgMembers = identity.table(
  'org_members',
  {
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: orgMemberRole('role').notNull().default('member'),
    seatAssigned: boolean('seat_assigned').notNull().default(true),
    /** SCIM 2.0 `externalId` (§8). Unique within an org when present. */
    scimExternalId: text('scim_external_id'),
    scimActive: boolean('scim_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.orgId, t.userId] }),
    index('org_members_user_idx').on(t.userId),
    uniqueIndex('org_members_scim_external_id_key').on(t.orgId, t.scimExternalId),
  ],
);

export const accounts = identity.table(
  'accounts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    provider: authProvider('provider').notNull(),
    providerAccountId: text('provider_account_id').notNull(),
    /** Only set for `saml`: which org connection produced this account. */
    orgId: uuid('org_id').references(() => orgs.id, { onDelete: 'cascade' }),
    email: text('email'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true, mode: 'date' }),
  },
  (t) => [
    uniqueIndex('accounts_provider_account_key').on(t.provider, t.providerAccountId),
    index('accounts_user_idx').on(t.userId),
    check(
      'accounts_saml_requires_org',
      sql`(${t.provider} <> 'saml') or (${t.orgId} is not null)`,
    ),
  ],
);

export const sessions = identity.table(
  'sessions',
  {
    /** SHA-256 of the opaque 256-bit session id. The raw id never touches disk. */
    id: text('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** Authentication methods (RFC 8176-ish): pwd, otp, webauthn, oidc, saml, link. */
    amr: text('amr').array().notNull().default(sql`'{}'::text[]`),
    privilegeVersion: integer('privilege_version').notNull(),
    mfaSatisfied: boolean('mfa_satisfied').notNull().default(false),
    /** Truncated SHA-256 — never the raw IP or user agent (§11, "no PII"). */
    ipHash: text('ip_hash'),
    uaHash: text('ua_hash'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true, mode: 'date' }),
    revokedReason: text('revoked_reason'),
  },
  (t) => [
    index('sessions_user_idx').on(t.userId),
    index('sessions_expires_idx').on(t.expiresAt),
    check('sessions_expiry_after_creation', sql`${t.expiresAt} > ${t.createdAt}`),
  ],
);

export const webauthnCredentials = identity.table(
  'webauthn_credentials',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** Base64url credential id as produced by the authenticator. */
    credentialId: text('credential_id').notNull(),
    publicKey: text('public_key').notNull(),
    counter: bigint('counter', { mode: 'number' }).notNull().default(0),
    transports: text('transports').array().notNull().default(sql`'{}'::text[]`),
    deviceType: text('device_type').notNull().default('singleDevice'),
    backedUp: boolean('backed_up').notNull().default(false),
    label: text('label'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true, mode: 'date' }),
  },
  (t) => [
    uniqueIndex('webauthn_credentials_credential_id_key').on(t.credentialId),
    index('webauthn_credentials_user_idx').on(t.userId),
    check('webauthn_credentials_counter_nonneg', sql`${t.counter} >= 0`),
  ],
);

export const magicLinks = identity.table(
  'magic_links',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    email: text('email').notNull(),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull(),
    redirectTo: text('redirect_to'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }).notNull(),
    consumedAt: timestamp('consumed_at', { withTimezone: true, mode: 'date' }),
  },
  (t) => [
    uniqueIndex('magic_links_token_hash_key').on(t.tokenHash),
    index('magic_links_email_idx').on(sql`lower(${t.email})`),
    check('magic_links_expiry_after_creation', sql`${t.expiresAt} > ${t.createdAt}`),
  ],
);

export const invites = identity.table(
  'invites',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    email: text('email').notNull(),
    role: orgMemberRole('role').notNull().default('member'),
    tokenHash: text('token_hash').notNull(),
    invitedBy: uuid('invited_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }).notNull(),
    acceptedAt: timestamp('accepted_at', { withTimezone: true, mode: 'date' }),
  },
  (t) => [
    uniqueIndex('invites_token_hash_key').on(t.tokenHash),
    uniqueIndex('invites_org_email_pending_key')
      .on(t.orgId, sql`lower(${t.email})`)
      .where(sql`${t.acceptedAt} is null`),
    check('invites_email_shape', EMAIL_CHECK),
  ],
);

export const apiKeys = identity.table(
  'api_keys',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    orgId: uuid('org_id').references(() => orgs.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    /** First 8 chars of the key, shown in the UI so a user can identify it. */
    prefix: text('prefix').notNull(),
    keyHash: text('key_hash').notNull(),
    scopes: text('scopes').array().notNull().default(sql`'{}'::text[]`),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true, mode: 'date' }),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }),
    revokedAt: timestamp('revoked_at', { withTimezone: true, mode: 'date' }),
  },
  (t) => [
    uniqueIndex('api_keys_key_hash_key').on(t.keyHash),
    index('api_keys_user_idx').on(t.userId),
  ],
);

export const samlConnections = identity.table(
  'saml_connections',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** One connection per org (§8). */
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    idpEntityId: text('idp_entity_id').notNull(),
    idpSsoUrl: text('idp_sso_url').notNull(),
    idpSloUrl: text('idp_slo_url'),
    idpCertificates: text('idp_certificates').array().notNull(),
    spEntityId: text('sp_entity_id').notNull(),
    spAcsUrl: text('sp_acs_url').notNull(),
    signatureAlgorithm: text('signature_algorithm').notNull().default('rsa-sha256'),
    digestAlgorithm: text('digest_algorithm').notNull().default('sha256'),
    wantAssertionsSigned: boolean('want_assertions_signed').notNull().default(true),
    allowIdpInitiated: boolean('allow_idp_initiated').notNull().default(false),
    /** IdP attribute name -> RedQuant profile field. */
    attributeMapping: jsonb('attribute_mapping')
      .$type<Record<string, string>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    defaultRole: orgMemberRole('default_role').notNull().default('member'),
    active: boolean('active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('saml_connections_org_key').on(t.orgId),
    uniqueIndex('saml_connections_idp_entity_key').on(t.idpEntityId),
    check('saml_connections_has_cert', sql`array_length(${t.idpCertificates}, 1) >= 1`),
  ],
);

export const scimTokens = identity.table(
  'scim_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull(),
    label: text('label').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true, mode: 'date' }),
    revokedAt: timestamp('revoked_at', { withTimezone: true, mode: 'date' }),
  },
  (t) => [
    uniqueIndex('scim_tokens_token_hash_key').on(t.tokenHash),
    index('scim_tokens_org_idx').on(t.orgId),
  ],
);

export const mfaMethods = identity.table(
  'mfa_methods',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    kind: mfaMethodKind('kind').notNull(),
    /** Encrypted TOTP seed, or the Argon2id hash of a single-use recovery code. */
    secret: text('secret').notNull(),
    label: text('label'),
    confirmedAt: timestamp('confirmed_at', { withTimezone: true, mode: 'date' }),
    consumedAt: timestamp('consumed_at', { withTimezone: true, mode: 'date' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => [
    index('mfa_methods_user_idx').on(t.userId),
    uniqueIndex('mfa_methods_user_totp_key')
      .on(t.userId)
      .where(sql`${t.kind} = 'totp'`),
  ],
);

export const authEvents = identity.table(
  'auth_events',
  {
    id: bigint('id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
    kind: text('kind').notNull(),
    succeeded: boolean('succeeded').notNull(),
    /** Never the raw address (§11). */
    ipHash: text('ip_hash'),
    detail: jsonb('detail').$type<Record<string, string | number | boolean>>(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => [index('auth_events_user_created_idx').on(t.userId, t.createdAt)],
);
