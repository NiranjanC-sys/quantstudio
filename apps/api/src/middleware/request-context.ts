/**
 * Request identity, tracing and structured logging (system-design §11).
 *
 * One span per request, W3C trace context propagated in and out, a `x-request-id`
 * that survives a proxy, and log lines that carry `trace_id` and never carry PII.
 */
import { context, propagation, SpanKind, SpanStatusCode, trace, type Span } from '@opentelemetry/api';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import { randomUUID } from 'node:crypto';
import { pseudonymise } from '../lib/crypto.js';
import { TRACER_NAME } from '../telemetry.js';

const SPAN_KEY = Symbol('redquant.span');
const START_KEY = Symbol('redquant.start');

interface Carried {
  [SPAN_KEY]?: Span;
  [START_KEY]?: bigint;
}

/** Routes whose traces are always sampled (§11). */
const ALWAYS_SAMPLE = [/^\/contests\/[^/]+\/submit$/, /^\/billing\//, /^\/labs\/submit$/];

function routeLabel(request: FastifyRequest): string {
  return request.routeOptions?.url ?? 'unrouted';
}

export const requestContextPlugin = fp(async (app: FastifyInstance) => {
  const { env, metrics } = app.services;
  const tracer = trace.getTracer(TRACER_NAME);

  app.decorateRequest('traceId', '');
  app.decorateRequest('clientIpHash', null);

  app.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
    const carried = request as unknown as Carried;
    carried[START_KEY] = process.hrtime.bigint();

    const incomingId = request.headers['x-request-id'];
    const requestId = typeof incomingId === 'string' && incomingId.length <= 200 ? incomingId : randomUUID();

    // Continue an upstream trace when the edge sent one.
    const parent = propagation.extract(context.active(), request.headers);
    const span = tracer.startSpan(
      `${request.method} ${routeLabel(request)}`,
      {
        kind: SpanKind.SERVER,
        attributes: {
          'http.request.method': request.method,
          'url.path': request.url.split('?')[0] ?? request.url,
          'server.address': request.hostname,
          'redquant.cell': env.CELL_ID,
          'redquant.request_id': requestId,
          'redquant.force_sample': ALWAYS_SAMPLE.some((re) => re.test(request.url)),
        },
      },
      parent,
    );

    carried[SPAN_KEY] = span;
    request.traceId = span.spanContext().traceId;
    request.clientIpHash = pseudonymise(env.PII_HASH_SECRET, request.ip);

    void reply.header('x-request-id', requestId);
    void reply.header('x-trace-id', request.traceId);

    metrics.httpInFlight.inc({ route: routeLabel(request) });
  });

  app.addHook('onResponse', async (request: FastifyRequest, reply: FastifyReply) => {
    const carried = request as unknown as Carried;
    const route = routeLabel(request);
    const status = String(reply.statusCode);

    metrics.httpInFlight.dec({ route });
    metrics.httpRequests.inc({ method: request.method, route, status, cell: env.CELL_ID });

    const start = carried[START_KEY];
    if (start !== undefined) {
      const seconds = Number(process.hrtime.bigint() - start) / 1e9;
      metrics.httpDuration.observe({ method: request.method, route, status }, seconds);
    }

    const span = carried[SPAN_KEY];
    if (span) {
      span.setAttribute('http.response.status_code', reply.statusCode);
      if (reply.statusCode >= 500) {
        span.setStatus({ code: SpanStatusCode.ERROR });
      }
      span.end();
    }
  });
});

/**
 * Pino configuration. §11: "structured JSON, Loki, no PII, trace_id on every
 * line." The redaction list is the belt; not logging bodies is the braces.
 */
export function loggerOptions(level: string, isProduction: boolean) {
  return {
    level,
    // Fastify's default request/response serialisers include headers and remote
    // address; both are replaced here.
    serializers: {
      req(request: FastifyRequest) {
        return {
          method: request.method,
          url: request.url.split('?')[0],
          route: request.routeOptions?.url,
          requestId: request.id,
          traceId: request.traceId,
          ipHash: request.clientIpHash,
          userId: request.auth?.userId,
        };
      },
      res(reply: FastifyReply) {
        return { statusCode: reply.statusCode };
      },
    },
    redact: {
      paths: [
        'req.headers.authorization',
        'req.headers.cookie',
        'req.headers["x-csrf-token"]',
        'req.headers["stripe-signature"]',
        'req.body.password',
        'req.body.token',
        'req.body.email',
        'res.headers["set-cookie"]',
      ],
      remove: true,
    },
    ...(isProduction ? {} : { transport: undefined }),
  };
}
