/**
 * RFC 9457 problem details. Every error path in the gateway returns one of
 * these, with `Content-Type: application/problem+json`.
 */
import type { FastifyReply, FastifyRequest } from 'fastify';
import { ZodError } from 'zod';

export const PROBLEM_CONTENT_TYPE = 'application/problem+json';
const PROBLEM_BASE = 'https://redquant.io/problems/';

export interface ProblemDetails {
  /** Stable URI identifying the problem class. */
  type: string;
  title: string;
  status: number;
  detail: string;
  instance?: string;
  /** Machine-readable code, mirrored from the last path segment of `type`. */
  code: string;
  traceId?: string;
  [extension: string]: unknown;
}

export type ProblemCode =
  | 'validation-failed'
  | 'unauthorized'
  | 'mfa-required'
  | 'forbidden'
  | 'entitlement-required'
  | 'credits-exhausted'
  | 'not-found'
  | 'conflict'
  | 'idempotency-key-reuse'
  | 'rate-limited'
  | 'payload-too-large'
  | 'unsupported-media-type'
  | 'contest-closed'
  | 'contest-cooldown'
  | 'prerequisites-unmet'
  | 'tutor-budget-exhausted'
  | 'tutor-disabled-during-contest'
  | 'upstream-unavailable'
  | 'write-unavailable'
  | 'internal-error';

const TITLES: Record<ProblemCode, string> = {
  'validation-failed': 'Request validation failed',
  unauthorized: 'Authentication required',
  'mfa-required': 'Multi-factor authentication required',
  forbidden: 'Insufficient permissions',
  'entitlement-required': 'Your plan does not include this feature',
  'credits-exhausted': 'Simulation credit balance exhausted',
  'not-found': 'Resource not found',
  conflict: 'Conflicting state',
  'idempotency-key-reuse': 'Idempotency key reused with a different request',
  'rate-limited': 'Rate limit exceeded',
  'payload-too-large': 'Payload too large',
  'unsupported-media-type': 'Unsupported media type',
  'contest-closed': 'Contest is not accepting submissions',
  'contest-cooldown': 'Per-problem cooldown in effect',
  'prerequisites-unmet': 'Lesson prerequisites are not satisfied',
  'tutor-budget-exhausted': 'AI tutor budget exhausted',
  'tutor-disabled-during-contest': 'Hints are disabled during a rated contest',
  'upstream-unavailable': 'Upstream service unavailable',
  'write-unavailable': 'Writes are temporarily unavailable',
  'internal-error': 'Internal server error',
};

const STATUSES: Record<ProblemCode, number> = {
  'validation-failed': 400,
  unauthorized: 401,
  'mfa-required': 401,
  forbidden: 403,
  'entitlement-required': 403,
  'credits-exhausted': 402,
  'not-found': 404,
  conflict: 409,
  'idempotency-key-reuse': 409,
  'rate-limited': 429,
  'payload-too-large': 413,
  'unsupported-media-type': 415,
  'contest-closed': 409,
  'contest-cooldown': 429,
  'prerequisites-unmet': 409,
  'tutor-budget-exhausted': 402,
  'tutor-disabled-during-contest': 403,
  'upstream-unavailable': 503,
  'write-unavailable': 503,
  'internal-error': 500,
};

export class ApiError extends Error {
  readonly code: ProblemCode;
  readonly status: number;
  readonly extensions: Record<string, unknown>;
  /** Set for 429 / 503 so the handler can emit `Retry-After`. */
  readonly retryAfterSeconds?: number;

  constructor(
    code: ProblemCode,
    detail: string,
    options: { extensions?: Record<string, unknown>; retryAfterSeconds?: number; cause?: unknown } = {},
  ) {
    super(detail, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'ApiError';
    this.code = code;
    this.status = STATUSES[code];
    this.extensions = options.extensions ?? {};
    if (options.retryAfterSeconds !== undefined) {
      this.retryAfterSeconds = options.retryAfterSeconds;
    }
  }

  toProblem(instance?: string, traceId?: string): ProblemDetails {
    const problem: ProblemDetails = {
      type: `${PROBLEM_BASE}${this.code}`,
      title: TITLES[this.code],
      status: this.status,
      detail: this.message,
      code: this.code,
      ...this.extensions,
    };
    if (instance !== undefined) problem.instance = instance;
    if (traceId !== undefined) problem.traceId = traceId;
    return problem;
  }
}

/** Shorthand constructors, so call sites read as prose. */
export const problem = {
  validation: (detail: string, extensions?: Record<string, unknown>) =>
    new ApiError('validation-failed', detail, extensions ? { extensions } : {}),
  unauthorized: (detail = 'A valid session is required.') => new ApiError('unauthorized', detail),
  mfaRequired: (detail = 'This role requires multi-factor authentication.') =>
    new ApiError('mfa-required', detail),
  forbidden: (detail: string) => new ApiError('forbidden', detail),
  entitlement: (feature: string, detail: string) =>
    new ApiError('entitlement-required', detail, { extensions: { feature } }),
  notFound: (what: string) => new ApiError('not-found', `${what} was not found.`),
  conflict: (detail: string, extensions?: Record<string, unknown>) =>
    new ApiError('conflict', detail, extensions ? { extensions } : {}),
  rateLimited: (detail: string, retryAfterSeconds: number, extensions?: Record<string, unknown>) =>
    new ApiError('rate-limited', detail, { retryAfterSeconds, extensions: extensions ?? {} }),
  upstream: (service: string, detail: string) =>
    new ApiError('upstream-unavailable', detail, { extensions: { service }, retryAfterSeconds: 5 }),
  internal: (detail = 'An unexpected error occurred.', cause?: unknown) =>
    new ApiError('internal-error', detail, cause === undefined ? {} : { cause }),
};

export function zodToProblem(error: ZodError): ApiError {
  return new ApiError('validation-failed', 'One or more fields failed validation.', {
    extensions: {
      errors: error.issues.map((issue) => ({
        path: issue.path.map(String).join('.'),
        message: issue.message,
        rule: issue.code,
      })),
    },
  });
}

interface FastifyValidationError extends Error {
  statusCode?: number;
  code?: string;
  validation?: unknown;
}

function isFastifyError(error: unknown): error is FastifyValidationError {
  return error instanceof Error && 'statusCode' in error;
}

/** Maps anything thrown inside a handler onto a problem+json response. */
export function toApiError(error: unknown): ApiError {
  if (error instanceof ApiError) return error;
  if (error instanceof ZodError) return zodToProblem(error);

  if (isFastifyError(error)) {
    const status = error.statusCode ?? 500;
    if (error.code === 'FST_ERR_CTP_INVALID_MEDIA_TYPE') {
      return new ApiError('unsupported-media-type', 'Request body must be application/json.');
    }
    if (error.code === 'FST_ERR_CTP_BODY_TOO_LARGE' || status === 413) {
      return new ApiError('payload-too-large', 'Request body exceeds the configured limit.');
    }
    if (status === 400) {
      return new ApiError('validation-failed', error.message);
    }
    if (status === 404) {
      return new ApiError('not-found', 'The requested endpoint does not exist.');
    }
    if (status === 401) return problem.unauthorized();
    if (status === 403) return problem.forbidden(error.message);
  }

  return problem.internal('An unexpected error occurred.', error);
}

export function sendProblem(
  request: FastifyRequest,
  reply: FastifyReply,
  error: ApiError,
): FastifyReply {
  const body = error.toProblem(request.url, request.traceId);
  if (error.retryAfterSeconds !== undefined) {
    void reply.header('retry-after', String(error.retryAfterSeconds));
  }
  return reply.status(error.status).type(PROBLEM_CONTENT_TYPE).send(body);
}
