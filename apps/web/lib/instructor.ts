/**
 * Client for the instructor dashboard.
 *
 * Every shape below was copied from a live response, not inferred from a route
 * name. The gateway serves these under `/instructor`, unversioned, exactly as
 * `ROUTE_MOUNTS` in apps/api/src/routes/index.ts declares. The field names that
 * are easy to guess wrong and are spelled here as the API actually spells them:
 *
 *   heatmap  -> `summary[].strugglingCount`, `summary[].coverage`, `weakest`
 *   gradebook-> `rows[].cells[].effectiveScore`, `autoScore`, `overall`
 *   cohorts  -> `items[].memberCount`, `joinCode`, `orgName`
 *
 * Errors are RFC 9457 problem documents with a machine-readable `code`, and the
 * codes matter: a 401 is either "sign in" (`unauthorized`) or "finish your
 * second factor" (`mfa-required`), and a 403 is either "wrong role"
 * (`forbidden`) or "wrong plan" (`entitlement-required`). Collapsing those into
 * one status would put the wrong next step in front of the reader, so this
 * module keeps the code and classifies it once.
 */

import { API_URL } from './api';

// --------------------------------------------------------------- transport

/** What went wrong, in terms the interface can act on. */
export type FailureKind =
  | 'unreachable'
  | 'unauthenticated'
  | 'mfa-required'
  | 'forbidden'
  | 'entitlement'
  | 'not-found'
  | 'rate-limited'
  | 'unconfigured'
  | 'invalid'
  | 'server';

export interface FieldError {
  path: string;
  message: string;
}

export interface Failure {
  ok: false;
  kind: FailureKind;
  status: number;
  code: string;
  detail: string;
  /** Present for `invalid`: the per-field list the gateway returns. */
  fields: FieldError[];
}

export type Remote<T> = { ok: true; data: T } | Failure;

interface ProblemBody {
  code?: string;
  detail?: string;
  title?: string;
  errors?: FieldError[];
  unknown?: number[];
}

/**
 * Maps a problem document onto the next step the reader can take. Exported
 * because lib/billing.ts speaks the same protocol and two copies of this table
 * would eventually disagree.
 */
export function classifyProblem(status: number, code: string): FailureKind {
  switch (code) {
    case 'unauthorized':
      return 'unauthenticated';
    case 'mfa-required':
      return 'mfa-required';
    case 'entitlement-required':
      return 'entitlement';
    case 'forbidden':
      return 'forbidden';
    case 'not-found':
      return 'not-found';
    case 'rate-limited':
      return 'rate-limited';
    case 'upstream-unavailable':
      return 'unconfigured';
    case 'validation-failed':
      return 'invalid';
    default:
      break;
  }
  if (status === 401) return 'unauthenticated';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'not-found';
  if (status === 429) return 'rate-limited';
  if (status === 400 || status === 409) return 'invalid';
  return 'server';
}

/**
 * The gateway pairs a session cookie with a CSRF token cookie that must be
 * echoed in a header. Reading it here keeps the double-submit intact; a
 * mutating call without it comes back 403 "CSRF token missing or does not
 * match", which is a real response this client has seen.
 */
export function csrfHeader(): Record<string, string> {
  if (typeof document === 'undefined') return {};
  const m = document.cookie.match(/(?:^|;\s*)rq_csrf=([^;]+)/);
  return m?.[1] ? { 'x-csrf-token': decodeURIComponent(m[1]) } : {};
}

async function request<T>(path: string, init?: RequestInit): Promise<Remote<T>> {
  const method = init?.method ?? 'GET';
  try {
    const res = await fetch(`${API_URL}${path}`, {
      credentials: 'include',
      ...init,
      headers: {
        accept: 'application/json',
        ...(method === 'GET' ? {} : { 'content-type': 'application/json', ...csrfHeader() }),
        ...(init?.headers ?? {}),
      },
    });

    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as ProblemBody | null;
      const code = body?.code ?? '';
      const unknownIds = body?.unknown;
      const fields = body?.errors ?? [];
      return {
        ok: false,
        kind: classifyProblem(res.status, code),
        status: res.status,
        code,
        detail:
          body?.detail ??
          body?.title ??
          `The gateway returned ${res.status}.`,
        fields:
          fields.length > 0
            ? fields
            : unknownIds && unknownIds.length > 0
              ? [{ path: 'lessonIds', message: `Unknown lesson ids: ${unknownIds.join(', ')}.` }]
              : [],
      };
    }

    if (res.status === 204) return { ok: true, data: undefined as T };
    return { ok: true, data: (await res.json()) as T };
  } catch {
    return {
      ok: false,
      kind: 'unreachable',
      status: 0,
      code: 'unreachable',
      detail: 'Could not reach the gateway.',
      fields: [],
    };
  }
}

// ------------------------------------------------------------------ shapes

/** A row of `GET /instructor/cohorts`. */
export interface CohortSummary {
  id: string;
  name: string;
  slug: string;
  term: string | null;
  trackId: number | null;
  joinCode: string;
  archived: boolean;
  createdAt: string;
  orgName: string;
  memberCount: number;
}

/** The `cohort` object of `GET /instructor/cohorts/:cohortId`. */
export interface Cohort {
  id: string;
  orgId: string;
  ownerId: string;
  name: string;
  slug: string;
  term: string | null;
  trackId: number | null;
  joinCode: string;
  archived: boolean;
  createdAt: string;
}

export interface CohortMember {
  userId: string;
  role: 'student' | 'assistant';
  joinedAt: string;
  handle: string;
  displayName: string;
  email: string;
}

export interface AssignmentSummary {
  id: string;
  title: string;
  points: number;
  dueAt: string | null;
  published: boolean;
  lessonIds: number[];
}

export interface CohortDetail {
  cohort: Cohort;
  members: CohortMember[];
  assignments: AssignmentSummary[];
}

export type GradeStatus =
  | 'not_started'
  | 'in_progress'
  | 'submitted'
  | 'graded'
  | 'excused';

export interface GradebookAssignment {
  id: string;
  title: string;
  points: number;
  dueAt: string | null;
  lessonIds: number[];
  published: boolean;
}

export interface GradebookCell {
  assignmentId: string;
  status: GradeStatus;
  /** The manually recorded score, `null` when nobody has graded it. */
  score: number | null;
  /** What lesson completion implies, `null` when the assignment names no lesson. */
  autoScore: number | null;
  /** `score` if one was recorded, otherwise `autoScore`. */
  effectiveScore: number | null;
  feedback: string | null;
  gradedAt: string | null;
}

export interface GradebookRow {
  userId: string;
  handle: string;
  displayName: string;
  email: string;
  cells: GradebookCell[];
  overall: number | null;
}

export interface Gradebook {
  assignments: GradebookAssignment[];
  rows: GradebookRow[];
}

export interface HeatmapConcept {
  id: number;
  slug: string;
  title: string;
}

export interface HeatmapStudent {
  userId: string;
  handle: string;
  displayName: string;
}

export interface HeatmapCell {
  userId: string;
  conceptId: number;
  /** Already decayed to "now" by the gateway, with the learner's own curve. */
  mastery: number;
  observations: number;
}

export interface HeatmapSummaryRow extends HeatmapConcept {
  /** Mean over the students who have a record, not over the whole cohort. */
  mean: number;
  /** Fraction of the cohort with any record for this concept. */
  coverage: number;
  strugglingCount: number;
}

export interface Heatmap {
  concepts: HeatmapConcept[];
  students: HeatmapStudent[];
  cells: HeatmapCell[];
  /** Absent only on the empty-cohort early return, which omits it. */
  summary?: HeatmapSummaryRow[];
  weakest?: HeatmapSummaryRow[];
}

export interface CreateCohortInput {
  name: string;
  slug: string;
  term?: string;
  trackCode?: string;
}

export interface CreateAssignmentInput {
  title: string;
  instructions?: string;
  lessonIds: number[];
  points: number;
  dueAt?: string;
  published: boolean;
}

// ------------------------------------------------------------------ calls

export function listCohorts(includeArchived = false): Promise<Remote<{ items: CohortSummary[] }>> {
  return request(`/instructor/cohorts?limit=100&includeArchived=${includeArchived ? 'true' : 'false'}`);
}

export function getCohort(cohortId: string): Promise<Remote<CohortDetail>> {
  return request(`/instructor/cohorts/${cohortId}`);
}

export function getGradebook(cohortId: string): Promise<Remote<Gradebook>> {
  return request(`/instructor/cohorts/${cohortId}/gradebook`);
}

export function getHeatmap(cohortId: string): Promise<Remote<Heatmap>> {
  return request(`/instructor/cohorts/${cohortId}/heatmap`);
}

export function createCohort(input: CreateCohortInput): Promise<Remote<{ id: string; joinCode: string }>> {
  return request('/instructor/cohorts', { method: 'POST', body: JSON.stringify(input) });
}

export function createAssignment(
  cohortId: string,
  input: CreateAssignmentInput,
): Promise<Remote<{ id: string }>> {
  return request(`/instructor/cohorts/${cohortId}/assignments`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

/**
 * The CSV lives behind the same session cookie as everything else, so it cannot
 * be handed to the browser as a bare link and still authenticate. Fetching it
 * with credentials and saving the blob keeps the export inside the session, and
 * keeps the filename the gateway chose in `content-disposition`.
 */
export async function downloadGradebookCsv(
  cohortId: string,
  fallbackName: string,
): Promise<Remote<{ filename: string }>> {
  try {
    const res = await fetch(`${API_URL}/instructor/cohorts/${cohortId}/export.csv`, {
      credentials: 'include',
      headers: { accept: 'text/csv' },
    });

    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as ProblemBody | null;
      const code = body?.code ?? '';
      return {
        ok: false,
        kind: classifyProblem(res.status, code),
        status: res.status,
        code,
        detail: body?.detail ?? `The export failed with ${res.status}.`,
        fields: [],
      };
    }

    const disposition = res.headers.get('content-disposition') ?? '';
    const match = disposition.match(/filename="([^"]+)"/);
    const filename = match?.[1] ?? fallbackName;

    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);

    return { ok: true, data: { filename } };
  } catch {
    return {
      ok: false,
      kind: 'unreachable',
      status: 0,
      code: 'unreachable',
      detail: 'Could not reach the gateway to build the export.',
      fields: [],
    };
  }
}

// ------------------------------------------------- catalogue, for the picker

export interface TrackSummary {
  id: number;
  code: string;
  title: string;
  moduleCount: number;
  lessonCount: number;
}

export interface ModuleSummary {
  id: number;
  code: string;
  slug: string;
  title: string;
  lessonCount: number;
}

export interface LessonSummary {
  id: number;
  slug: string;
  title: string;
  kind: string;
  estimatedMinutes: number;
  xp: number;
}

export function listTracks(): Promise<Remote<{ items: TrackSummary[] }>> {
  return request('/catalog/tracks');
}

export function getTrack(code: string): Promise<Remote<{ track: TrackSummary; modules: ModuleSummary[] }>> {
  return request(`/catalog/tracks/${code}`);
}

export function getModule(
  code: string,
): Promise<Remote<{ module: ModuleSummary; lessons: LessonSummary[] }>> {
  return request(`/catalog/modules/${code}`);
}

// ---------------------------------------------------------------- helpers

/**
 * Five bands, because a continuous ramp cannot be read back off a legend and
 * because the interface prints the number in the cell anyway. The band index is
 * what selects a background colour whose contrast against the theme's ink has
 * been measured; see styles/instructor.css.
 */
export const MASTERY_BANDS = [
  { min: 0, max: 0.2, label: '0 to 20%' },
  { min: 0.2, max: 0.4, label: '20 to 40%' },
  { min: 0.4, max: 0.6, label: '40 to 60%' },
  { min: 0.6, max: 0.8, label: '60 to 80%' },
  { min: 0.8, max: 1.0001, label: '80 to 100%' },
] as const;

export function masteryBand(mastery: number): number {
  const index = MASTERY_BANDS.findIndex((band) => mastery >= band.min && mastery < band.max);
  return index === -1 ? MASTERY_BANDS.length - 1 : index;
}

/** `userId:conceptId` -> cell, so the grid is a lookup rather than a scan. */
export function indexHeatmap(cells: HeatmapCell[]): Map<string, HeatmapCell> {
  return new Map(cells.map((cell) => [`${cell.userId}:${cell.conceptId}`, cell]));
}

export function formatPercent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

/** Dates are printed in one fixed locale so two readers compare the same string. */
export function formatDate(iso: string | null): string {
  if (!iso) return 'No due date';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return 'Unknown';
  return new Intl.DateTimeFormat('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  }).format(date);
}

export const GRADE_STATUS_LABEL: Record<GradeStatus, string> = {
  not_started: 'Not started',
  in_progress: 'In progress',
  submitted: 'Submitted',
  graded: 'Graded',
  excused: 'Excused',
};
