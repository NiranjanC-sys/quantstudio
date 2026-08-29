/**
 * Builds the Fastify instance.
 *
 * Kept separate from `server.ts` so the integration suite can stand a whole
 * gateway up against throwaway Postgres and Redis without binding a port or
 * installing signal handlers.
 *
 * Plugin order is load-bearing and is asserted by the comments below: security
 * (cookies, CORS, CSRF) must exist before anything reads a cookie; the request
 * context must exist before auth, because auth logs and hashes the client
 * address; auth must exist before read-your-own-writes, which keys off the
 * caller's identity.
 */
import Fastify, { LogController, type FastifyInstance } from 'fastify';
import type { Env } from './env.js';
import { sendProblem, toApiError } from './errors.js';
import { authPlugin } from './middleware/auth.js';
import { readYourWritesPlugin } from './middleware/read-your-writes.js';
import { loggerOptions, requestContextPlugin } from './middleware/request-context.js';
import { securityPlugin } from './middleware/security.js';
import { registerRoutes } from './routes/index.js';
import type { Services } from './services.js';
import { createServices, closeServices } from './services.js';

export interface BuiltApp {
  app: FastifyInstance;
  services: Services;
  /** Closes the Fastify instance *and* every connection the container owns. */
  close(): Promise<void>;
}

export interface BuildOptions {
  /** Reuse an existing container, which is how tests avoid a second pool. */
  services?: Services;
}

export async function buildApp(env: Env, options: BuildOptions = {}): Promise<BuiltApp> {
  const app = Fastify({
    logger: loggerOptions(env.LOG_LEVEL, env.NODE_ENV === 'production'),
    bodyLimit: env.BODY_LIMIT_BYTES,
    // The edge terminates TLS and sets X-Forwarded-*; without this every client
    // IP would be the load balancer's and the per-IP limits in §9 would be
    // meaningless.
    trustProxy: true,
    // A SAML RelayState or a base64url credential id is longer than Fastify's
    // 100-character default for a single route parameter.
    routerOptions: { maxParamLength: 512 },
    // Per-request access logs are redundant once every request is a span and a
    // metric (§11), and in production they are the bulk of the log bill.
    logController: new LogController({
      disableRequestLogging: env.NODE_ENV === 'production',
    }),
    genReqId: () => crypto.randomUUID(),
  });

  const services = options.services ?? (await createServices(env, app.log));
  app.decorate('services', services);

  // 1. Transport hardening: cookies, CORS allowlist, helmet headers, CSRF.
  await app.register(securityPlugin);
  // 2. Trace id, request id, pseudonymised client address, golden-signal metrics.
  await app.register(requestContextPlugin);
  // 3. Session / API key / service token resolution and entitlement refresh.
  await app.register(authPlugin);
  // 4. §5 read-your-own-writes routing, which needs the resolved identity.
  await app.register(readYourWritesPlugin);

  /**
   * Every error leaves as RFC 9457 problem+json (`src/errors.ts`). Nothing else
   * in the codebase formats an error response, which is what makes the contract
   * checkable.
   */
  app.setErrorHandler((error, request, reply) => {
    const apiError = toApiError(error);

    if (apiError.status >= 500) {
      // §11: 100% sampling for errors, and the cause is logged once, here.
      request.log.error(
        { err: error, traceId: request.traceId, route: request.routeOptions?.url },
        'request failed',
      );
    } else {
      request.log.debug(
        { code: apiError.code, traceId: request.traceId, route: request.routeOptions?.url },
        'request rejected',
      );
    }

    return sendProblem(request, reply, apiError);
  });

  app.setNotFoundHandler((request, reply) =>
    sendProblem(request, reply, toApiError(Object.assign(new Error('Not found'), { statusCode: 404 }))),
  );

  await registerRoutes(app);
  await app.ready();

  return {
    app,
    services,
    async close() {
      await app.close();
      if (!options.services) await closeServices(services);
    },
  };
}
