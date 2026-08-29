/**
 * Every environment variable the gateway reads, validated once at boot.
 *
 * The process refuses to start on invalid configuration rather than failing at
 * the first request that happens to need it. See `.env.example` for prose.
 */
import { z } from 'zod';

const bool = z
  .enum(['true', 'false', '1', '0'])
  .transform((v) => v === 'true' || v === '1');

const csv = z
  .string()
  .transform((v) =>
    v
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
  );

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  CELL_ID: z.string().default('cell-0'),
  SERVICE_NAME: z.string().default('api-gateway'),
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3001),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  BODY_LIMIT_BYTES: z.coerce.number().int().positive().default(1_048_576),
  SHUTDOWN_GRACE_MS: z.coerce.number().int().positive().default(15_000),

  /** Public origin of the API itself; used to build OAuth redirect URIs. */
  API_PUBLIC_URL: z.string().url().default('http://localhost:3001'),
  /** Public origin of the web app; used for redirects after auth and checkout. */
  WEB_PUBLIC_URL: z.string().url().default('http://localhost:3000'),
  CORS_ALLOWED_ORIGINS: csv.default('http://localhost:3000'),

  DATABASE_URL: z.string().url(),
  /** Replica pool for read-only queries (§5, read/write split). Falls back to primary. */
  DATABASE_REPLICA_URL: z.string().url().optional(),
  DATABASE_POOL_MAX: z.coerce.number().int().positive().default(20),
  DATABASE_REPLICA_POOL_MAX: z.coerce.number().int().positive().default(40),
  DATABASE_STATEMENT_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
  DATABASE_SSL: bool.default('false'),

  REDIS_URL: z.string().url(),
  REDIS_KEY_PREFIX: z.string().default(''),

  SESSION_COOKIE_NAME: z.string().default('rq_session'),
  /** §8: sliding 14 days. */
  SESSION_TTL_SECONDS: z.coerce.number().int().positive().default(14 * 24 * 60 * 60),
  SESSION_COOKIE_DOMAIN: z.string().optional(),
  SESSION_COOKIE_SECURE: bool.default('true'),
  CSRF_COOKIE_NAME: z.string().default('rq_csrf'),
  /** HMAC key for the double-submit CSRF token. Required outside development. */
  CSRF_SECRET: z.string().min(32).default('dev-only-csrf-secret-change-me-0000000000'),
  /** HMAC key used to pseudonymise IPs and user agents before they are logged. */
  PII_HASH_SECRET: z.string().min(32).default('dev-only-pii-hash-secret-change-me-000000'),

  /** AES-256-GCM key (any length >= 32) protecting stored TOTP seeds. */
  MFA_ENCRYPTION_KEY: z.string().min(32).default('dev-only-mfa-encryption-key-change-me-000'),

  ARGON2_MEMORY_KIB: z.coerce.number().int().positive().default(65_536),
  ARGON2_TIME_COST: z.coerce.number().int().positive().default(3),
  ARGON2_PARALLELISM: z.coerce.number().int().positive().default(4),

  /** §8: short-lived EdDSA JWTs for internal service calls. PKCS#8 / SPKI PEM. */
  SERVICE_JWT_PRIVATE_KEY: z.string().optional(),
  SERVICE_JWT_PUBLIC_KEY: z.string().optional(),
  SERVICE_JWT_ISSUER: z.string().default('https://api.redquant.io'),
  // Audiences the gateway MINTS for, i.e. the services it calls out to.
  SERVICE_JWT_AUDIENCE: csv.default('quantum-kernel,grader,ai-tutor'),
  // The audience the gateway ACCEPTS on the way back in, and deliberately not
  // one of the above. A token minted for `ai-tutor` is handed to a third party
  // over the wire; if the gateway also accepted it inbound, whoever read it out
  // of the tutor's logs could replay it here as that user. Outbound and inbound
  // are different directions and must not share a credential.
  SERVICE_JWT_INBOUND_AUDIENCE: z.string().min(1).default('api-gateway'),
  SERVICE_JWT_TTL_SECONDS: z.coerce.number().int().positive().max(900).default(300),

  MAGIC_LINK_TTL_SECONDS: z.coerce.number().int().positive().default(900),
  EMAIL_FROM: z.string().default('no-reply@redquant.io'),
  EMAIL_TRANSPORT: z.enum(['console', 'queue']).default('console'),

  WEBAUTHN_RP_ID: z.string().default('localhost'),
  WEBAUTHN_RP_NAME: z.string().default('RedQuant'),
  WEBAUTHN_ORIGINS: csv.default('http://localhost:3000'),

  OIDC_GOOGLE_CLIENT_ID: z.string().optional(),
  OIDC_GOOGLE_CLIENT_SECRET: z.string().optional(),
  OIDC_MICROSOFT_CLIENT_ID: z.string().optional(),
  OIDC_MICROSOFT_CLIENT_SECRET: z.string().optional(),
  OIDC_MICROSOFT_TENANT: z.string().default('organizations'),
  OIDC_GITHUB_CLIENT_ID: z.string().optional(),
  OIDC_GITHUB_CLIENT_SECRET: z.string().optional(),
  OIDC_ORCID_CLIENT_ID: z.string().optional(),
  OIDC_ORCID_CLIENT_SECRET: z.string().optional(),
  OIDC_ORCID_ISSUER: z.string().url().default('https://orcid.org'),
  OIDC_LINKEDIN_CLIENT_ID: z.string().optional(),
  OIDC_LINKEDIN_CLIENT_SECRET: z.string().optional(),

  SAML_SP_ENTITY_ID: z.string().default('https://api.redquant.io/auth/saml/metadata'),
  SAML_ASSERTION_SKEW_SECONDS: z.coerce.number().int().nonnegative().default(120),

  STRIPE_SECRET_KEY: z.string().optional(),
  STRIPE_WEBHOOK_SECRET: z.string().optional(),
  STRIPE_PRICE_PRO: z.string().optional(),
  STRIPE_PRICE_TEAMS: z.string().optional(),
  STRIPE_PRICE_CAMPUS: z.string().optional(),

  QUANTUM_KERNEL_URL: z.string().url().default('http://localhost:8100'),
  QUANTUM_KERNEL_TIMEOUT_MS: z.coerce.number().int().positive().default(900),

  AI_TUTOR_URL: z.string().url().default('http://localhost:8200'),
  AI_TUTOR_TIMEOUT_MS: z.coerce.number().int().positive().default(60_000),
  /** §7 + §9: hard ceilings the tutor gateway enforces before proxying. */
  TUTOR_DAILY_TOKEN_CEILING: z.coerce.number().int().positive().default(50_000),
  TUTOR_HOURLY_COST_CEILING_USD: z.coerce.number().positive().default(40),
  TUTOR_COST_PER_1K_INPUT_USD: z.coerce.number().nonnegative().default(0.003),
  TUTOR_COST_PER_1K_OUTPUT_USD: z.coerce.number().nonnegative().default(0.015),

  RATE_LIMIT_ENABLED: bool.default('true'),
  IDEMPOTENCY_TTL_SECONDS: z.coerce.number().int().positive().default(86_400),
  /** §5: reads route to the primary within this window of a user's own write. */
  READ_YOUR_WRITES_WINDOW_MS: z.coerce.number().int().positive().default(500),

  OTEL_ENABLED: bool.default('false'),
  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().url().optional(),
  OTEL_TRACE_SAMPLE_RATIO: z.coerce.number().min(0).max(1).default(0.01),
  METRICS_ENABLED: bool.default('true'),

  /** §9 degradation ladder steps 1-2, flipped by the operator or by autoscaling. */
  DEGRADE_SIM_QUEUE_ONLY: bool.default('false'),
  DEGRADE_MAX_QUBITS: z.coerce.number().int().positive().optional(),
});

/**
 * The development placeholders that ship in `.env.example`.
 *
 * They exist so a checkout boots with one command. They are also in the public
 * repository, so a production process that fell back to one of them would be
 * signing CSRF tokens and encrypting TOTP seeds with a published key. The
 * refinement below turns that from a silent default into a startup failure.
 */
const DEV_PLACEHOLDER_SECRETS: Record<string, string> = {
  CSRF_SECRET: 'dev-only-csrf-secret-change-me-0000000000',
  PII_HASH_SECRET: 'dev-only-pii-hash-secret-change-me-000000',
  MFA_ENCRYPTION_KEY: 'dev-only-mfa-encryption-key-change-me-000',
};

/** Configuration that is optional in development but must be present in production. */
const REQUIRED_IN_PRODUCTION = ['SERVICE_JWT_PRIVATE_KEY', 'SERVICE_JWT_PUBLIC_KEY'] as const;

const productionSafe = <T extends z.ZodTypeAny>(schema: T) =>
  schema.superRefine((value: unknown, ctx: z.RefinementCtx) => {
    const env = value as Record<string, unknown>;
    if (env.NODE_ENV !== 'production') return;

    for (const [key, placeholder] of Object.entries(DEV_PLACEHOLDER_SECRETS)) {
      if (env[key] === placeholder) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [key],
          message:
            'is still the development placeholder from .env.example. Generate a unique value ' +
            '(for example `openssl rand -base64 48`) before running in production.',
        });
      }
    }

    for (const key of REQUIRED_IN_PRODUCTION) {
      if (!env[key]) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [key],
          message: 'is required in production; an ephemeral key pair is a development-only convenience.',
        });
      }
    }

    if (env.SESSION_COOKIE_SECURE !== true) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['SESSION_COOKIE_SECURE'],
        message: 'must be true in production; a session cookie without Secure travels over plain HTTP.',
      });
    }
  });

const validatedEnvSchema = productionSafe(envSchema);

export type Env = z.infer<typeof envSchema>;

let cached: Env | null = null;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = validatedEnvSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  return parsed.data;
}

export function env(): Env {
  cached ??= loadEnv();
  return cached;
}

/** Test helper: forget the memoised environment so a suite can re-load it. */
export function resetEnvCache(): void {
  cached = null;
}
