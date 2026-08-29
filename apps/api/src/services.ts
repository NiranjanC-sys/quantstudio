/**
 * The service container. Everything with a connection, a key or a cache is built
 * once here and handed to the Fastify instance, which keeps route modules free
 * of module-level singletons and makes the integration suite able to stand a
 * whole gateway up against throwaway Postgres and Redis containers.
 */
import type { FastifyBaseLogger } from 'fastify';
import Stripe from 'stripe';
import { createDatabase, type DatabaseHandles } from './db/client.js';
import type { Env } from './env.js';
import { createEntitlementService, type EntitlementService } from './entitlements/service.js';
import { createMagicLinkService, type MagicLinkService } from './auth/magic-link.js';
import { createOidcRegistry, type OidcRegistry } from './auth/oidc.js';
import { createPasskeyService, type PasskeyService } from './auth/webauthn.js';
import { createPasswordHasher, type PasswordHasher } from './auth/password.js';
import { createSamlService, type SamlService } from './auth/saml.js';
import { createServiceTokenIssuer, type ServiceTokenIssuer } from './auth/service-jwt.js';
import { createSessionStore, type SessionStore } from './auth/session.js';
import { createMailer, type Mailer } from './lib/mailer.js';
import { createQueues, type Queues } from './queues/index.js';
import { createRateLimiter, type RateLimiter } from './middleware/rate-limit.js';
import { createRedis, type RedisHandles } from './redis/client.js';
import { createScriptRunner, type ScriptRunner } from './redis/scripts.js';
import { createMetrics, startTracing, type Metrics, type Telemetry } from './telemetry.js';

export interface Services {
  env: Env;
  db: DatabaseHandles;
  redis: RedisHandles;
  scripts: ScriptRunner;
  metrics: Metrics;
  limiter: RateLimiter;
  telemetry: Telemetry;
  queues: Queues;
  sessions: SessionStore;
  entitlements: EntitlementService;
  passwords: PasswordHasher;
  passkeys: PasskeyService;
  magicLinks: MagicLinkService;
  oidc: OidcRegistry;
  saml: SamlService;
  serviceTokens: ServiceTokenIssuer;
  mailer: Mailer;
  /** `null` when Stripe is not configured; billing routes then fail closed. */
  stripe: Stripe | null;
}

export async function createServices(env: Env, logger: FastifyBaseLogger): Promise<Services> {
  const telemetry = startTracing(env);
  const db = createDatabase(env);
  const redis = createRedis(env);
  const scripts = createScriptRunner(redis.client);
  const metrics = createMetrics(env);

  // BullMQ requires a connection with `maxRetriesPerRequest: null`; sharing the
  // command connection would change semantics for every other caller.
  const queues = createQueues(env, redis.client.duplicate({ maxRetriesPerRequest: null }));

  const mailer = createMailer(env, logger, env.EMAIL_TRANSPORT === 'queue' ? queues.email : null);

  const services: Services = {
    env,
    db,
    redis,
    scripts,
    metrics,
    limiter: createRateLimiter(redis.client, scripts, metrics, env.RATE_LIMIT_ENABLED),
    telemetry,
    queues,
    sessions: createSessionStore(env, db, redis.client),
    entitlements: createEntitlementService(db, redis.client),
    passwords: createPasswordHasher(env),
    passkeys: createPasskeyService(env, db, redis.client),
    magicLinks: createMagicLinkService(env, db, mailer),
    oidc: createOidcRegistry(env, redis.client),
    saml: createSamlService(env, db, redis.client),
    serviceTokens: await createServiceTokenIssuer(env),
    mailer,
    stripe: env.STRIPE_SECRET_KEY
      ? new Stripe(env.STRIPE_SECRET_KEY, {
          // Pinning the API version means a Stripe upgrade is a deploy, not a
          // surprise on a Tuesday.
          apiVersion: '2025-02-24.acacia',
          maxNetworkRetries: 2,
          timeout: 10_000,
        })
      : null,
  };

  return services;
}

export async function closeServices(services: Services): Promise<void> {
  await services.queues.close();
  await services.redis.close();
  await services.db.close();
  await services.telemetry.shutdown();
}
