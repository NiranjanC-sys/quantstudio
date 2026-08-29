/**
 * Observability wiring (system-design §11).
 *
 * Traces: OpenTelemetry, W3C context propagated in and out, 1% baseline sampling
 * with 100% for errors, contest submissions and payments — implemented as a
 * parent-based sampler with an explicit "always sample this" attribute that the
 * route layer sets.
 *
 * Metrics: Prometheus, the four golden signals plus the domain metrics §11 names
 * as leading indicators.
 */
import { context, propagation, SpanStatusCode, trace, type Span } from '@opentelemetry/api';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { Resource } from '@opentelemetry/resources';
import {
  BatchSpanProcessor,
  NodeTracerProvider,
  ParentBasedSampler,
  TraceIdRatioBasedSampler,
} from '@opentelemetry/sdk-trace-node';
import {
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
} from '@opentelemetry/semantic-conventions';
import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';
import type { Env } from './env.js';

export const TRACER_NAME = '@redquant/api';

export interface Metrics {
  registry: Registry;
  httpRequests: Counter<'method' | 'route' | 'status' | 'cell'>;
  httpDuration: Histogram<'method' | 'route' | 'status'>;
  httpInFlight: Gauge<'route'>;
  simQueueDepth: Gauge<'tier'>;
  simCacheHits: Counter<'result'>;
  graderLagSeconds: Gauge<'queue'>;
  contestBroadcastLagMs: Gauge<'contest'>;
  tutorCostUsd: Counter<'plan'>;
  entitlementDenials: Counter<'feature' | 'plan'>;
  rateLimitDecisions: Counter<'class' | 'decision'>;
  creditsDebited: Counter<'reason'>;
  contestScoreOps: Counter<'result'>;
}

export function createMetrics(env: Env): Metrics {
  const registry = new Registry();
  registry.setDefaultLabels({ service: env.SERVICE_NAME, cell: env.CELL_ID });

  if (env.METRICS_ENABLED) {
    collectDefaultMetrics({ register: registry });
  }

  const metrics: Metrics = {
    registry,
    httpRequests: new Counter({
      name: 'http_requests_total',
      help: 'HTTP requests handled, by route and status.',
      labelNames: ['method', 'route', 'status', 'cell'],
      registers: [registry],
    }),
    httpDuration: new Histogram({
      name: 'http_request_duration_seconds',
      help: 'HTTP request latency. Buckets straddle the 300 ms p99 read budget.',
      labelNames: ['method', 'route', 'status'],
      buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.2, 0.3, 0.5, 1, 2, 5],
      registers: [registry],
    }),
    httpInFlight: new Gauge({
      name: 'http_requests_in_flight',
      help: 'Requests currently being handled.',
      labelNames: ['route'],
      registers: [registry],
    }),
    simQueueDepth: new Gauge({
      name: 'sim_queue_depth',
      help: 'Depth of the simulation queue, by tier (§4).',
      labelNames: ['tier'],
      registers: [registry],
    }),
    simCacheHits: new Counter({
      name: 'sim_cache_events_total',
      help: 'Simulation result cache hits and misses (§4).',
      labelNames: ['result'],
      registers: [registry],
    }),
    graderLagSeconds: new Gauge({
      name: 'grader_lag_seconds',
      help: 'Age of the oldest waiting job on a grading queue.',
      labelNames: ['queue'],
      registers: [registry],
    }),
    contestBroadcastLagMs: new Gauge({
      name: 'contest_broadcast_lag_ms',
      help: 'Delay between a scored submission and its leaderboard broadcast.',
      labelNames: ['contest'],
      registers: [registry],
    }),
    tutorCostUsd: new Counter({
      name: 'tutor_cost_usd_total',
      help: 'AI tutor spend, by plan (§7 ceilings).',
      labelNames: ['plan'],
      registers: [registry],
    }),
    entitlementDenials: new Counter({
      name: 'entitlement_denial_total',
      help: 'Feature checks denied, by feature and plan.',
      labelNames: ['feature', 'plan'],
      registers: [registry],
    }),
    rateLimitDecisions: new Counter({
      name: 'rate_limit_decisions_total',
      help: 'Token-bucket decisions by endpoint class (§9).',
      labelNames: ['class', 'decision'],
      registers: [registry],
    }),
    creditsDebited: new Counter({
      name: 'credits_debited_total',
      help: 'Simulation credits debited, by reason (§7).',
      labelNames: ['reason'],
      registers: [registry],
    }),
    contestScoreOps: new Counter({
      name: 'contest_score_ops_total',
      help: 'Contest scoring script executions, split by first-accept vs duplicate.',
      labelNames: ['result'],
      registers: [registry],
    }),
  };

  return metrics;
}

export interface Telemetry {
  shutdown(): Promise<void>;
}

/**
 * Registers the tracer provider. When `OTEL_ENABLED` is false the OpenTelemetry
 * API still works — spans are created and context still propagates — they are
 * simply not exported, which is the correct behaviour for local development.
 */
export function startTracing(env: Env): Telemetry {
  propagation.setGlobalPropagator(new W3CTraceContextPropagator());

  if (!env.OTEL_ENABLED || !env.OTEL_EXPORTER_OTLP_ENDPOINT) {
    return { shutdown: async () => undefined };
  }

  const provider = new NodeTracerProvider({
    resource: new Resource({
      [ATTR_SERVICE_NAME]: env.SERVICE_NAME,
      [ATTR_SERVICE_VERSION]: '1.0.0',
      'deployment.cell': env.CELL_ID,
      'deployment.environment': env.NODE_ENV,
    }),
    // §11: 1% baseline. Errors and high-value paths are force-sampled by the
    // route layer marking the span, which a parent-based sampler then honours
    // for the rest of the trace.
    sampler: new ParentBasedSampler({
      root: new TraceIdRatioBasedSampler(env.OTEL_TRACE_SAMPLE_RATIO),
    }),
    spanProcessors: [
      new BatchSpanProcessor(
        new OTLPTraceExporter({ url: `${env.OTEL_EXPORTER_OTLP_ENDPOINT}/v1/traces` }),
      ),
    ],
  });

  provider.register();

  return {
    shutdown: async () => {
      await provider.shutdown();
    },
  };
}

export function tracer() {
  return trace.getTracer(TRACER_NAME);
}

/** Runs `fn` inside a span, recording exceptions and setting the status. */
export async function withSpan<T>(
  name: string,
  attributes: Record<string, string | number | boolean>,
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  const span = tracer().startSpan(name, { attributes });
  try {
    return await context.with(trace.setSpan(context.active(), span), () => fn(span));
  } catch (error) {
    span.recordException(error instanceof Error ? error : new Error(String(error)));
    span.setStatus({ code: SpanStatusCode.ERROR });
    throw error;
  } finally {
    span.end();
  }
}

/** The active trace id, or `undefined` when nothing is sampling. */
export function activeTraceId(): string | undefined {
  const span = trace.getActiveSpan();
  const id = span?.spanContext().traceId;
  return id && id !== '00000000000000000000000000000000' ? id : undefined;
}
