/**
 * Client for the AI tutor gateway.
 *
 * Written against `apps/api/src/routes/tutor.ts` and against live responses
 * from that route, not against its route names. What was observed on
 * `http://localhost:3001`, with a real session cookie:
 *
 *   GET  /tutor/usage    -> 200 {plan, messagesPerDay, tokenCeilingPerDay,
 *                                hourlyCostCeilingUsd, tokensToday,
 *                                messagesToday, cellCostThisHourUsd,
 *                                retrievalOnly, hintsBlockedByContest}
 *                           401 problem+json when there is no session.
 *   POST /tutor/messages -> text/event-stream, or a problem+json error before
 *                           the stream opens.
 *
 * The stream the browser actually sees, captured end to end:
 *
 *   event: meta   data: {mode, retrievalOnly, reason, plan, traceId}
 *   ... frames proxied verbatim from the ai-tutor worker ...
 *   event: usage  data: {inputTokens, outputTokens, costUsd}
 *   event: done   data: {}
 *
 * and, if the proxy loop throws part way through,
 *
 *   event: error  data: {code, detail}
 *
 * `meta`, `usage`, `done` and `error` are written by the gateway itself, so
 * those four are contract. The frames in between are passed through byte for
 * byte from the `ai-tutor` worker, and that worker is not in this repository
 * (only its Dockerfile and manifests are). Its frame shape is therefore *not*
 * something this file can know. Rather than invent one, `readDelta` and
 * `readCitations` accept a short, documented list of shapes and count anything
 * else as unrecognised, and the panel reports the count instead of pretending
 * the answer was empty on purpose. Adding a shape here is a one line change
 * once the worker lands.
 *
 * Nothing in this module throws. Every call returns a discriminated result, the
 * way `lib/api.ts` does, because a tutor that fails must say so rather than
 * spin.
 */

import { emit, type Circuit, type CircuitMetrics, type SimResult, type ValidationIssue } from '@redquant/qir';
import { API_URL, api } from './api';

/* ------------------------------------------------------------------ modes -- */

/** The four modes the gateway's Zod schema accepts. Anything else is a 400. */
export type TutorWireMode = 'chat' | 'hint' | 'explain' | 'review';

/**
 * The five things a learner actually asks for. The wire has four modes, so the
 * product intents fold onto them and carry a directive in the message body.
 * `hint` is the one the gateway treats as an integrity concern, so it must stay
 * a distinct wire mode rather than being folded into `chat`.
 */
export type TutorIntent = 'explain' | 'hint' | 'debug' | 'optimise' | 'next';

export interface TutorIntentSpec {
  id: TutorIntent;
  label: string;
  wireMode: TutorWireMode;
  /** Prepended to the learner's text so the worker knows the task. */
  directive: string;
  /** Shown under the mode row. */
  blurb: string;
  /** Field label for the composer. */
  prompt: string;
  /** Whether the circuit is attached by default in this mode. */
  attachesCircuit: boolean;
}

export const TUTOR_INTENTS: readonly TutorIntentSpec[] = [
  {
    id: 'explain',
    label: 'Explain',
    wireMode: 'explain',
    directive:
      'Explain this from first principles, then give the smallest worked example that makes it concrete. Cite the lessons you drew on.',
    blurb: 'A concept, an identity, a piece of notation. Answers are grounded in the curriculum and cited.',
    prompt: 'What should I explain?',
    attachesCircuit: false,
  },
  {
    id: 'hint',
    label: 'Hint',
    wireMode: 'hint',
    directive:
      'Give exactly one Socratic hint. Ask a question that moves me one step forward. Do not state the answer, do not write the gate sequence, and do not give code.',
    blurb:
      'Socratic. The request asks for a question back, never the solution. Disabled while you are registered in a running rated contest.',
    prompt: 'What are you stuck on?',
    attachesCircuit: true,
  },
  {
    id: 'debug',
    label: 'Debug my circuit',
    wireMode: 'review',
    directive:
      'Debug the circuit below. Name the operation that is wrong, say why the simulated output differs from what I expected, and stop before rewriting the whole thing.',
    blurb: 'Sends the circuit IR and the simulator output, so the answer is about your circuit and not a generic one.',
    prompt: 'What did you expect to happen?',
    attachesCircuit: true,
  },
  {
    id: 'optimise',
    label: 'Critique and optimise',
    wireMode: 'review',
    directive:
      'Critique the circuit below and propose a cheaper equivalent. State what the depth, the two qubit count and the T count would become, and why the rewrite is equivalent.',
    blurb: 'Depth, two qubit count and T count are the numbers that matter. Ask for the rewrite and the reason for it.',
    prompt: 'Anything to weigh up, for example depth against T count?',
    attachesCircuit: true,
  },
  {
    id: 'next',
    label: 'What next',
    wireMode: 'chat',
    directive:
      'Given where I am, tell me what to study or build next, and why that rather than the obvious alternative.',
    blurb: 'A route through the curriculum from where you are now.',
    prompt: 'Where are you now, and what are you aiming at?',
    attachesCircuit: false,
  },
];

export function intentSpec(id: TutorIntent): TutorIntentSpec {
  return TUTOR_INTENTS.find((i) => i.id === id) ?? TUTOR_INTENTS[0]!;
}

/* ------------------------------------------------------------------ types -- */

/** The gateway caps `message` at 8000 characters and `history` at 20 turns. */
export const TUTOR_MESSAGE_MAX = 8_000;
export const TUTOR_HISTORY_MAX = 20;

export interface TutorTurn {
  role: 'user' | 'assistant';
  content: string;
}

export interface TutorUsageSnapshot {
  plan: string;
  messagesPerDay: number;
  tokenCeilingPerDay: number;
  hourlyCostCeilingUsd: number;
  tokensToday: number;
  messagesToday: number;
  cellCostThisHourUsd: number;
  /** True when the tutor is answering from retrieval only (system-design §9 step 3). */
  retrievalOnly: boolean;
  /** True when a running rated registration blocks hint mode (§6 integrity). */
  hintsBlockedByContest: boolean;
}

export interface TutorMeta {
  mode: TutorWireMode;
  retrievalOnly: boolean;
  reason: 'hourly-cost-ceiling' | 'operator' | null;
  plan: string;
  traceId: string;
}

export interface TutorTurnUsage {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

export interface TutorCitation {
  title: string;
  /** Lesson path such as `t0/m1/l1-bits-and-states`, when one was resolvable. */
  slug: string | null;
  /** Link target, or null when the citation cannot be resolved to a lesson. */
  href: string | null;
  external: boolean;
  lessonId: number | null;
  score: number | null;
  quote: string | null;
}

/**
 * Every way a tutor request can fail, each one with a next step the panel can
 * offer. `detail` is the gateway's own wording where there is one.
 */
export type TutorFailure =
  | { kind: 'unauthenticated'; detail: string }
  | { kind: 'budget-exhausted'; detail: string; tokensToday: number | null; ceiling: number | null }
  | { kind: 'message-limit'; detail: string; limit: number | null; retryAfterSeconds: number | null }
  | { kind: 'contest-lock'; detail: string; contest: string | null }
  | { kind: 'upstream'; detail: string; retryAfterSeconds: number | null }
  | { kind: 'network'; detail: string }
  | { kind: 'invalid'; detail: string }
  | { kind: 'forbidden'; detail: string }
  | { kind: 'cancelled'; detail: string }
  | { kind: 'server'; detail: string; status: number };

export type TutorUsageResult =
  | { ok: true; usage: TutorUsageSnapshot }
  | { ok: false; failure: TutorFailure };

export interface TutorStreamHandlers {
  onMeta?: (meta: TutorMeta) => void;
  onDelta?: (text: string, full: string) => void;
  onCitations?: (citations: TutorCitation[]) => void;
  onUsage?: (usage: TutorTurnUsage) => void;
}

export interface TutorOutcomeCommon {
  /** Whatever text arrived, including a partial answer before a mid-stream failure. */
  text: string;
  citations: TutorCitation[];
  meta: TutorMeta | null;
  usage: TutorTurnUsage | null;
  /** Frames the parser did not recognise as content, citation or accounting. */
  unrecognisedFrames: number;
}

export type TutorOutcome =
  | ({ ok: true } & TutorOutcomeCommon)
  | ({ ok: false; failure: TutorFailure } & TutorOutcomeCommon);

/* ------------------------------------------------------------------ csrf --- */

/**
 * The gateway pairs an httpOnly session cookie with a readable `rq_csrf`
 * cookie that must be echoed in `x-csrf-token`. Same double submit as
 * `lib/kernel.ts`; that copy is module private, so this is the second reader
 * rather than a second scheme.
 */
function csrfHeader(): Record<string, string> {
  if (typeof document === 'undefined') return {};
  const m = document.cookie.match(/(?:^|;\s*)rq_csrf=([^;]+)/);
  return m?.[1] ? { 'x-csrf-token': decodeURIComponent(m[1]) } : {};
}

/* ---------------------------------------------------------------- errors --- */

interface ProblemDetails {
  title?: string;
  detail?: string;
  code?: string;
  status?: number;
  [key: string]: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

/** Maps an RFC 9457 problem onto a failure. The `code` is authoritative; status is the fallback. */
export function failureFromProblem(
  status: number,
  problem: ProblemDetails | null,
  retryAfterSeconds: number | null,
): TutorFailure {
  const code = problem?.code ?? '';
  const detail = problem?.detail ?? problem?.title ?? `The tutor request failed with ${status}.`;

  if (code === 'unauthorized' || code === 'mfa-required' || status === 401) {
    return { kind: 'unauthenticated', detail };
  }
  if (code === 'tutor-budget-exhausted' || status === 402) {
    return {
      kind: 'budget-exhausted',
      detail,
      tokensToday: numberOrNull(problem?.['tokensToday']),
      ceiling: numberOrNull(problem?.['ceiling']),
    };
  }
  if (code === 'tutor-disabled-during-contest') {
    return { kind: 'contest-lock', detail, contest: stringOrNull(problem?.['contest']) };
  }
  if (code === 'rate-limited' || status === 429) {
    return {
      kind: 'message-limit',
      detail,
      limit: numberOrNull(problem?.['limit']),
      retryAfterSeconds,
    };
  }
  if (code === 'upstream-unavailable' || status === 503) {
    return { kind: 'upstream', detail, retryAfterSeconds };
  }
  if (code === 'validation-failed' || code === 'payload-too-large' || status === 400 || status === 413) {
    return { kind: 'invalid', detail };
  }
  if (code === 'forbidden' || status === 403) {
    return { kind: 'forbidden', detail };
  }
  return { kind: 'server', detail, status };
}

/** In-band `event: error` frames carry a code but no HTTP status. */
function failureFromStreamError(payload: unknown): TutorFailure {
  const record = isRecord(payload) ? payload : {};
  const detail = stringOrNull(record['detail']) ?? 'The tutor stream ended unexpectedly.';
  const code = stringOrNull(record['code']) ?? 'upstream-unavailable';
  return failureFromProblem(503, { code, detail }, null);
}

/* ----------------------------------------------------------------- usage --- */

export async function fetchTutorUsage(signal?: AbortSignal): Promise<TutorUsageResult> {
  const res = await api<TutorUsageSnapshot>('/tutor/usage', signal ? { signal } : undefined);
  if (res.ok) return { ok: true, usage: res.data };
  if (res.status === 0) {
    return {
      ok: false,
      failure: { kind: 'network', detail: 'Could not reach the gateway, so your tutor budget is unknown.' },
    };
  }
  return { ok: false, failure: failureFromProblem(res.status, { detail: res.detail }, null) };
}

/* ------------------------------------------------------------- citations --- */

const LESSON_PATH = /^[a-z0-9]+(?:\/[a-z0-9][a-z0-9-]*){1,3}$/;

/** `t0/m1/l1-bits-and-states` becomes `/learn/t0/m1/l1-bits-and-states`. Anything else becomes null. */
export function lessonHref(raw: string): string | null {
  const slug = raw.trim().replace(/^\/+/, '').replace(/^learn\//, '').replace(/\/+$/, '').toLowerCase();
  return LESSON_PATH.test(slug) ? `/learn/${slug}` : null;
}

function firstString(source: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = stringOrNull(source[key]);
    if (value !== null) return value;
  }
  return null;
}

function toCitation(value: unknown): TutorCitation | null {
  if (typeof value === 'string') {
    const href = lessonHref(value);
    return {
      title: value,
      slug: href ? value.replace(/^\/?(learn\/)?/, '') : null,
      href,
      external: false,
      lessonId: null,
      score: null,
      quote: null,
    };
  }
  if (!isRecord(value)) return null;

  const rawSlug = firstString(value, ['lessonSlug', 'slug', 'lessonPath', 'path', 'lesson']);
  const href = rawSlug ? lessonHref(rawSlug) : null;
  const link = firstString(value, ['href', 'url']);
  const external = href === null && link !== null && /^https?:\/\//i.test(link);
  const title =
    firstString(value, ['title', 'lessonTitle', 'label', 'heading', 'name']) ?? rawSlug ?? link ?? null;

  if (title === null) return null;

  return {
    title,
    slug: href ? href.slice('/learn/'.length) : null,
    href: href ?? (external ? link : link && link.startsWith('/') ? link : null),
    external,
    lessonId: numberOrNull(value['lessonId']),
    score: numberOrNull(value['score']) ?? numberOrNull(value['relevance']),
    quote: firstString(value, ['quote', 'snippet', 'excerpt']),
  };
}

/**
 * Citation shapes accepted, in order: an `event: citation` or `event: source`
 * frame carrying one object; a `citations` or `sources` array on any frame; a
 * bare string. Everything else is left alone.
 */
export function readCitations(event: string | null, payload: unknown): TutorCitation[] {
  const out: TutorCitation[] = [];
  const push = (v: unknown) => {
    const c = toCitation(v);
    if (c) out.push(c);
  };

  if (event === 'citation' || event === 'source') push(payload);

  if (isRecord(payload)) {
    for (const key of ['citations', 'sources', 'retrieved']) {
      const list = payload[key];
      if (Array.isArray(list)) for (const item of list) push(item);
    }
    if (event !== 'citation' && event !== 'source') {
      const single = payload['citation'] ?? payload['source'];
      if (single !== undefined) push(single);
    }
  }
  return out;
}

/* ----------------------------------------------------------------- delta --- */

/**
 * Text shapes accepted: a non-JSON `data:` line; `{delta: string}`;
 * `{delta: {text}}`; `{text}`; `{content: string}`; `{token}`; and
 * `{choices: [{delta: {content}}]}`. Anything else yields null and is counted.
 */
export function readDelta(payload: unknown): string | null {
  if (typeof payload === 'string') return payload === '' ? null : payload;
  if (!isRecord(payload)) return null;

  for (const key of ['delta', 'text', 'content', 'token', 'chunk']) {
    const value = payload[key];
    if (typeof value === 'string' && value !== '') return value;
    if (isRecord(value)) {
      const nested = value['text'] ?? value['content'];
      if (typeof nested === 'string' && nested !== '') return nested;
    }
  }

  const choices = payload['choices'];
  if (Array.isArray(choices) && isRecord(choices[0])) {
    const delta = choices[0]['delta'];
    if (isRecord(delta) && typeof delta['content'] === 'string' && delta['content'] !== '') {
      return delta['content'];
    }
  }
  return null;
}

/* --------------------------------------------------------------- compose --- */

export interface ComposedMessage {
  /** Exactly what goes on the wire. Shown to the learner before it is sent. */
  message: string;
  contextIncluded: boolean;
  contextTruncated: boolean;
}

/**
 * Order matters: directive, then the learner's question, then the circuit. The
 * gateway hard caps the body at 8000 characters, so if anything has to go it is
 * the tail of the circuit dump and never the question.
 */
export function composeTutorMessage(
  intent: TutorIntent,
  text: string,
  context: string | null,
): ComposedMessage {
  const spec = intentSpec(intent);
  const head = `${spec.directive}\n\n${text.trim()}`;

  if (!context || context.trim() === '') {
    return { message: head.slice(0, TUTOR_MESSAGE_MAX), contextIncluded: false, contextTruncated: false };
  }

  const marker = '\n[circuit truncated to fit the 8000 character message limit]';
  const room = TUTOR_MESSAGE_MAX - head.length - 2;
  if (room < 240) {
    return { message: head.slice(0, TUTOR_MESSAGE_MAX), contextIncluded: false, contextTruncated: true };
  }
  if (context.length <= room) {
    return { message: `${head}\n\n${context}`, contextIncluded: true, contextTruncated: false };
  }
  const clipped = `${context.slice(0, room - marker.length)}${marker}`;
  return { message: `${head}\n\n${clipped}`, contextIncluded: true, contextTruncated: true };
}

/* --------------------------------------------------------------- circuit --- */

export interface CircuitContext {
  circuit: Circuit;
  stats: CircuitMetrics;
  issues: ValidationIssue[];
  result: SimResult | null;
  simError: string | null;
  shots: number;
  seed: number;
  bindings: Record<string, number>;
  noiseEnabled: boolean;
  noise: { depolarising1: number; depolarising2: number; readout: number };
  hash: string;
}

function topStates(result: SimResult, limit: number): { label: string; p: number }[] {
  const rows: { label: string; p: number }[] = [];
  const probabilities = result.probabilities;
  for (let i = 0; i < probabilities.length; i += 1) {
    const p = probabilities[i] ?? 0;
    if (p > 1e-9) rows.push({ label: i.toString(2).padStart(result.qubits, '0'), p });
  }
  rows.sort((a, b) => b.p - a.p);
  return rows.slice(0, limit);
}

/**
 * The circuit and its simulated output, as plain text.
 *
 * This is the product's differentiator and it has to travel inside `message`:
 * the gateway's Zod schema has `mode`, `message`, `lessonId`,
 * `contestProblemId` and `history`, and Zod strips anything else, so a
 * `circuit` field would be silently discarded. Text keeps it verifiable, and
 * the panel shows the learner the exact block before it is sent.
 */
export function buildCircuitContext(ctx: CircuitContext, maxStates = 8): string {
  const { circuit, stats, result } = ctx;
  const lines: string[] = [];

  lines.push(`--- my circuit (RedQuant IR v${circuit.version}, hash ${ctx.hash.slice(0, 12)}) ---`);
  lines.push(
    `name ${circuit.name}; qubits ${stats.qubits}; clbits ${stats.clbits}; depth ${stats.depth}; ops ${stats.size}`,
  );
  lines.push(
    `1q ${stats.singleQubitGates}; 2q ${stats.twoQubitGates}; 3q+ ${stats.multiQubitGates}; ` +
      `measurements ${stats.measurements}; T count ${stats.tCount}; Clifford ${stats.clifford ? 'yes' : 'no'}`,
  );

  const counts = Object.entries(stats.gateCounts);
  if (counts.length > 0) {
    lines.push(`gate counts: ${counts.map(([g, n]) => `${g} ${n}`).join(', ')}`);
  }

  const bindings = Object.entries(ctx.bindings);
  if (bindings.length > 0) {
    lines.push(`bindings: ${bindings.map(([s, v]) => `${s} = ${v}`).join(', ')}`);
  }

  for (const issue of ctx.issues) {
    lines.push(`validation ${issue.severity}: ${issue.message}`);
  }

  lines.push('');
  lines.push('OpenQASM 3:');
  try {
    lines.push(emit(circuit, 'qasm3').trimEnd());
  } catch (error) {
    lines.push(`(source could not be emitted: ${error instanceof Error ? error.message : String(error)})`);
  }

  lines.push('');
  const noise = ctx.noiseEnabled
    ? `noise on, 1q ${ctx.noise.depolarising1}, 2q ${ctx.noise.depolarising2}, readout ${ctx.noise.readout}`
    : 'noise off';
  lines.push(`simulation: browser statevector, shots ${ctx.shots}, seed ${ctx.seed}, ${noise}`);

  if (result === null) {
    lines.push(`simulation did not run: ${ctx.simError ?? 'no result available'}`);
  } else {
    lines.push('largest basis state probabilities:');
    for (const row of topStates(result, maxStates)) {
      lines.push(`  |${row.label}>  ${row.p.toFixed(6)}`);
    }
    if (result.counts) {
      const shots = Object.entries(result.counts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, maxStates)
        .map(([label, n]) => `${label} ${n}`)
        .join(', ');
      if (shots) lines.push(`shot counts: ${shots}`);
    }
    if (result.stochastic) {
      lines.push(`this run was sampled over ${result.trajectories} trajectories, so amplitudes are absent`);
    }
  }
  lines.push('--- end of circuit ---');

  return lines.join('\n');
}

/* ---------------------------------------------------------------- stream --- */

export interface TutorRequest {
  intent: TutorIntent;
  /** The learner's own words. The directive and the circuit are added here. */
  text: string;
  /** Output of `buildCircuitContext`, or null. */
  context?: string | null;
  lessonId?: number | null;
  contestProblemId?: string | null;
  history?: TutorTurn[];
  signal?: AbortSignal;
}

function trimHistory(history: TutorTurn[]): TutorTurn[] {
  return history
    .slice(-TUTOR_HISTORY_MAX)
    .map((turn) => ({ role: turn.role, content: turn.content.slice(0, TUTOR_MESSAGE_MAX) }))
    .filter((turn) => turn.content.trim() !== '');
}

/** Splits one SSE frame into its event name and its concatenated data lines. */
function parseFrame(frame: string): { event: string | null; data: string } {
  let event: string | null = null;
  const data: string[] = [];
  for (const line of frame.split('\n')) {
    if (line === '' || line.startsWith(':')) continue;
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
  }
  return { event, data: data.join('\n') };
}

function readMeta(payload: unknown): TutorMeta | null {
  if (!isRecord(payload)) return null;
  const mode = stringOrNull(payload['mode']);
  const reason = stringOrNull(payload['reason']);
  return {
    mode: (mode === 'chat' || mode === 'hint' || mode === 'explain' || mode === 'review' ? mode : 'chat'),
    retrievalOnly: payload['retrievalOnly'] === true,
    reason: reason === 'hourly-cost-ceiling' || reason === 'operator' ? reason : null,
    plan: stringOrNull(payload['plan']) ?? 'unknown',
    traceId: stringOrNull(payload['traceId']) ?? '',
  };
}

function readTurnUsage(payload: unknown): TutorTurnUsage | null {
  if (!isRecord(payload)) return null;
  const input = numberOrNull(payload['inputTokens']);
  const output = numberOrNull(payload['outputTokens']);
  if (input === null && output === null) return null;
  return { inputTokens: input ?? 0, outputTokens: output ?? 0, costUsd: numberOrNull(payload['costUsd']) ?? 0 };
}

/**
 * Opens the SSE stream and drains it.
 *
 * Resolves either way. A failure part way through keeps whatever text had
 * already arrived, because a half answer plus an honest error beats a blank
 * panel.
 */
export async function streamTutorMessage(
  request: TutorRequest,
  handlers: TutorStreamHandlers = {},
): Promise<TutorOutcome> {
  const spec = intentSpec(request.intent);
  const composed = composeTutorMessage(request.intent, request.text, request.context ?? null);

  const body: Record<string, unknown> = {
    mode: spec.wireMode,
    message: composed.message,
    history: trimHistory(request.history ?? []),
  };
  if (typeof request.lessonId === 'number' && request.lessonId > 0) body['lessonId'] = request.lessonId;
  if (request.contestProblemId) body['contestProblemId'] = request.contestProblemId;

  let text = '';
  const citations: TutorCitation[] = [];
  let meta: TutorMeta | null = null;
  let usage: TutorTurnUsage | null = null;
  let unrecognisedFrames = 0;

  const snapshot = (): TutorOutcomeCommon => ({ text, citations, meta, usage, unrecognisedFrames });

  let response: Response;
  try {
    response = await fetch(`${API_URL}/tutor/messages`, {
      method: 'POST',
      credentials: 'include',
      headers: {
        'content-type': 'application/json',
        accept: 'text/event-stream',
        ...csrfHeader(),
      },
      body: JSON.stringify(body),
      ...(request.signal ? { signal: request.signal } : {}),
    });
  } catch (error) {
    if ((error as Error).name === 'AbortError') {
      return { ok: false, failure: { kind: 'cancelled', detail: 'Request stopped.' }, ...snapshot() };
    }
    return {
      ok: false,
      failure: {
        kind: 'network',
        detail:
          'The browser could not read a reply from the gateway. Either it is not running, or it ' +
          'answered the stream without the cross-origin headers a browser needs.',
      },
      ...snapshot(),
    };
  }

  if (!response.ok) {
    const problem = (await response.json().catch(() => null)) as ProblemDetails | null;
    const header = response.headers.get('retry-after');
    const retryAfter = header !== null && header !== '' ? Number(header) : null;
    return {
      ok: false,
      failure: failureFromProblem(
        response.status,
        problem,
        retryAfter !== null && Number.isFinite(retryAfter) ? retryAfter : null,
      ),
      ...snapshot(),
    };
  }

  if (!response.body) {
    return {
      ok: false,
      failure: { kind: 'upstream', detail: 'The tutor responded without a stream body.', retryAfterSeconds: null },
      ...snapshot(),
    };
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let failure: TutorFailure | null = null;
  let done = false;

  const handleFrame = (frame: string): void => {
    const { event, data } = parseFrame(frame);
    if (data === '' || data === '[DONE]') return;

    let payload: unknown = data;
    try {
      payload = JSON.parse(data);
    } catch {
      // A non-JSON data line is content, which is legal SSE.
    }

    if (event === 'meta') {
      meta = readMeta(payload);
      if (meta) handlers.onMeta?.(meta);
      return;
    }
    if (event === 'usage') {
      const turn = readTurnUsage(payload);
      if (turn) {
        usage = turn;
        handlers.onUsage?.(turn);
      }
      return;
    }
    if (event === 'done') {
      done = true;
      return;
    }
    if (event === 'error') {
      failure = failureFromStreamError(payload);
      return;
    }

    const found = readCitations(event, payload);
    if (found.length > 0) {
      citations.push(...found);
      handlers.onCitations?.(found);
    }

    const delta = readDelta(payload);
    if (delta !== null) {
      text += delta;
      handlers.onDelta?.(delta, text);
      return;
    }

    // The gateway's own accounting frames and pure citation frames are not
    // content and are not a mystery either.
    if (found.length === 0 && !(isRecord(payload) && 'usage' in payload)) {
      unrecognisedFrames += 1;
    }
  };

  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });

      let boundary = buffer.indexOf('\n\n');
      while (boundary !== -1) {
        handleFrame(buffer.slice(0, boundary));
        buffer = buffer.slice(boundary + 2);
        boundary = buffer.indexOf('\n\n');
      }
    }
    if (buffer.trim() !== '') handleFrame(buffer);
  } catch (error) {
    if ((error as Error).name === 'AbortError') {
      return { ok: false, failure: { kind: 'cancelled', detail: 'Answer stopped.' }, ...snapshot() };
    }
    return {
      ok: false,
      failure: { kind: 'network', detail: 'The connection dropped part way through the answer.' },
      ...snapshot(),
    };
  }

  if (failure !== null) return { ok: false, failure, ...snapshot() };

  if (!done && text === '') {
    return {
      ok: false,
      failure: { kind: 'upstream', detail: 'The tutor closed the stream before answering.', retryAfterSeconds: null },
      ...snapshot(),
    };
  }

  return { ok: true, ...snapshot() };
}

/* ------------------------------------------------------------- formatting -- */

export function formatCount(n: number): string {
  return n.toLocaleString('en-GB');
}

export function formatUsd(n: number): string {
  return n < 0.01 && n > 0 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`;
}

/** Whether the per-plan message ceiling from system-design §7 is already spent. */
export function messagesExhausted(usage: TutorUsageSnapshot): boolean {
  return usage.messagesToday >= usage.messagesPerDay;
}

export function tokensExhausted(usage: TutorUsageSnapshot): boolean {
  return usage.tokensToday >= usage.tokenCeilingPerDay;
}
