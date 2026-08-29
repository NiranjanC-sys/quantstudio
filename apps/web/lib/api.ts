/**
 * Typed client for the gateway.
 *
 * Every call can fail for a reason the learner should see rather than a spinner
 * that never resolves, so the client returns a discriminated result instead of
 * throwing. The API being down must degrade a page, never blank it.
 */

export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

/*
 * Note on versioning: the gateway serves unversioned paths (`/catalog/tracks`,
 * not `/v1/catalog/tracks`). The kernel does version its API. Unifying them is
 * worth doing, but it is a coordinated change across the gateway's routes, its
 * 113 tests and the Kubernetes probes, not something to do from the client.
 */

export type ApiResult<T> =
  | { ok: true; data: T }
  | { ok: false; status: number; detail: string };

export async function api<T>(path: string, init?: RequestInit): Promise<ApiResult<T>> {
  try {
    const res = await fetch(`${API_URL}${path}`, {
      credentials: 'include',
      headers: { accept: 'application/json', ...(init?.headers ?? {}) },
      ...init,
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { detail?: string; title?: string } | null;
      return {
        ok: false,
        status: res.status,
        detail: body?.detail ?? body?.title ?? `Request failed with ${res.status}.`,
      };
    }
    return { ok: true, data: (await res.json()) as T };
  } catch {
    return { ok: false, status: 0, detail: 'Could not reach the API.' };
  }
}

export interface Page<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
}

export interface LeaderboardRow {
  rank: number;
  userId: number;
  displayName: string | null;
  username?: string | null;
  score: number;
  institution?: string | null;
}

/**
 * Shapes below were taken from live responses, not from reading route names.
 * An earlier version of this file guessed and was wrong in four field names.
 */
export interface ProgressOverview {
  mastery: {
    overall: number;
    lessonsCompleted: number;
    unlockedCount: number;
    version: number;
  } | null;
  streak: {
    current: number;
    longest: number;
    lastActiveDate: string | null;
    freezeTokens: number;
    timezone: string;
  } | null;
  xp: { total: number };
  reviewsDue: number;
}

export interface NextLesson {
  id: number;
  slug: string;
  title: string;
  kind: string;
  estimatedMinutes: number;
  xp: number;
  moduleCode: string;
  trackCode: string;
  score: number;
  reason: string;
  readable: boolean;
}
