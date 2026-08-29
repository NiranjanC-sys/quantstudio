/**
 * Outbound HTTP with a deadline. Every upstream call in the gateway goes through
 * here so that a slow dependency turns into a typed 503 rather than a hung
 * request holding an event-loop slot.
 */
import { ApiError } from '../errors.js';

export interface FetchJsonOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  headers?: Record<string, string>;
  body?: unknown;
  timeoutMs: number;
  service: string;
  signal?: AbortSignal;
}

export interface HttpResult<T> {
  status: number;
  body: T;
}

export async function fetchJson<T>(url: string, options: FetchJsonOptions): Promise<HttpResult<T>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);

  const onAbort = (): void => controller.abort();
  options.signal?.addEventListener('abort', onAbort, { once: true });

  try {
    const response = await fetch(url, {
      method: options.method ?? 'GET',
      headers: {
        accept: 'application/json',
        ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
        ...options.headers,
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      signal: controller.signal,
    });

    const text = await response.text();
    let parsed: unknown = null;
    if (text.length > 0) {
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new ApiError(
          'upstream-unavailable',
          `${options.service} returned a non-JSON body (status ${response.status}).`,
          { extensions: { service: options.service }, retryAfterSeconds: 2 },
        );
      }
    }

    return { status: response.status, body: parsed as T };
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if (error instanceof Error && error.name === 'AbortError') {
      throw new ApiError(
        'upstream-unavailable',
        `${options.service} did not respond within ${options.timeoutMs} ms.`,
        { extensions: { service: options.service }, retryAfterSeconds: 2, cause: error },
      );
    }
    throw new ApiError('upstream-unavailable', `${options.service} is unreachable.`, {
      extensions: { service: options.service },
      retryAfterSeconds: 5,
      cause: error,
    });
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', onAbort);
  }
}
