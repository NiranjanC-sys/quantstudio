/**
 * Route registration. One place that names every prefix the gateway serves, so
 * "what does this service expose" is answerable by reading a single file.
 *
 * Each module is a plain (encapsulated) Fastify plugin, not a `fastify-plugin`,
 * which is what lets a module install its own hooks — a content-type parser for
 * SAML, a raw-body parser for Stripe, an entitlement guard for the instructor
 * dashboard — without leaking them across the rest of the API.
 */
import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { adminRoutes } from './admin.js';
import { authRoutes } from './auth.js';
import { billingRoutes } from './billing.js';
import { catalogRoutes } from './catalog.js';
import { contestRoutes } from './contests.js';
import { healthRoutes } from './health.js';
import { instructorRoutes } from './instructor.js';
import { labRoutes } from './labs.js';
import { leaderboardRoutes } from './leaderboard.js';
import { progressRoutes } from './progress.js';
import { tutorRoutes } from './tutor.js';

export interface RouteMount {
  prefix: string;
  plugin: FastifyPluginAsync;
}

export const ROUTE_MOUNTS: readonly RouteMount[] = [
  // Health is mounted at the root: /healthz, /readyz and /metrics are what the
  // load balancer, Kubernetes and Prometheus expect to find there.
  { prefix: '/', plugin: healthRoutes },
  { prefix: '/auth', plugin: authRoutes },
  { prefix: '/catalog', plugin: catalogRoutes },
  { prefix: '/progress', plugin: progressRoutes },
  { prefix: '/labs', plugin: labRoutes },
  { prefix: '/contests', plugin: contestRoutes },
  { prefix: '/leaderboard', plugin: leaderboardRoutes },
  { prefix: '/billing', plugin: billingRoutes },
  { prefix: '/instructor', plugin: instructorRoutes },
  { prefix: '/tutor', plugin: tutorRoutes },
  { prefix: '/admin', plugin: adminRoutes },
] as const;

export async function registerRoutes(app: FastifyInstance): Promise<void> {
  for (const mount of ROUTE_MOUNTS) {
    await app.register(mount.plugin, { prefix: mount.prefix });
  }
}
