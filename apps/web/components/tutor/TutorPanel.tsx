'use client';

/**
 * The tutor conversation surface.
 *
 * Two things this panel is careful about.
 *
 * First, it sends the learner's *actual* circuit. The gateway's request schema
 * has no field for IR, and Zod strips unknown keys, so the circuit travels as
 * text inside `message` and the learner can read the exact block before it
 * goes. That is the difference between a tutor that talks about Grover and one
 * that talks about your Grover.
 *
 * Second, it never spins. An unreachable gateway, a visitor with no session and
 * a spent budget are three different messages with three different next steps,
 * following components/app/RemoteState.tsx. A failure part way through a stream
 * keeps the partial answer and says what happened underneath it, because
 * deleting half an answer is its own kind of lie.
 */

import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { Loading, Unavailable } from '@/components/app/RemoteState';
import { useCircuit } from '@/lib/circuit-store';
import {
  TUTOR_INTENTS,
  TUTOR_MESSAGE_MAX,
  buildCircuitContext,
  composeTutorMessage,
  fetchTutorUsage,
  formatCount,
  formatUsd,
  intentSpec,
  messagesExhausted,
  streamTutorMessage,
  tokensExhausted,
  type TutorCitation,
  type TutorFailure,
  type TutorIntent,
  type TutorMeta,
  type TutorTurn,
  type TutorTurnUsage,
  type TutorUsageSnapshot,
} from '@/lib/tutor';
import '@/styles/tutor.css';

interface Entry {
  id: string;
  role: 'user' | 'assistant';
  intent: TutorIntent;
  text: string;
  /** User entries only: how many characters of circuit context went with it. */
  attachedChars: number;
  /** Assistant entries only. */
  streaming: boolean;
  citations: TutorCitation[];
  meta: TutorMeta | null;
  usage: TutorTurnUsage | null;
  failure: TutorFailure | null;
  settled: boolean;
}

type UsageState =
  | { kind: 'loading' }
  | { kind: 'ready'; usage: TutorUsageSnapshot }
  | { kind: 'failed'; failure: TutorFailure };

export interface TutorPanelProps {
  variant?: 'page' | 'dock';
  /** Numeric lesson id, when the panel is opened from a lesson. */
  lessonId?: number;
  contestProblemId?: string;
  /** Rendered at the right of the panel header, for example a dock close button. */
  headerExtra?: React.ReactNode;
}

let entrySeq = 0;
function nextId(): string {
  entrySeq += 1;
  return `t${entrySeq}`;
}

export function TutorPanel({ variant = 'page', lessonId, contestProblemId, headerExtra }: TutorPanelProps) {
  const baseId = useId();
  const headingId = `${baseId}-title`;
  const inputId = `${baseId}-input`;
  const blockId = `${baseId}-block`;

  const [usageState, setUsageState] = useState<UsageState>({ kind: 'loading' });
  const [intent, setIntent] = useState<TutorIntent>('explain');
  const [draft, setDraft] = useState('');
  const [entries, setEntries] = useState<Entry[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [attach, setAttach] = useState(true);
  const [mounted, setMounted] = useState(false);

  const abortRef = useRef<AbortController | null>(null);
  const logRef = useRef<HTMLDivElement | null>(null);

  const circuit = useCircuit((s) => s.circuit);
  const stats = useCircuit((s) => s.stats);
  const issues = useCircuit((s) => s.issues);
  const result = useCircuit((s) => s.result);
  const simError = useCircuit((s) => s.simError);
  const shots = useCircuit((s) => s.shots);
  const seed = useCircuit((s) => s.seed);
  const bindings = useCircuit((s) => s.bindings);
  const noiseEnabled = useCircuit((s) => s.noiseEnabled);
  const noise = useCircuit((s) => s.noise);
  const hash = useCircuit((s) => s.hash);

  const spec = intentSpec(intent);
  const hasCircuit = circuit.ops.length > 0;

  useEffect(() => setMounted(true), []);

  const loadUsage = useCallback(async () => {
    setUsageState({ kind: 'loading' });
    const res = await fetchTutorUsage();
    setUsageState(res.ok ? { kind: 'ready', usage: res.usage } : { kind: 'failed', failure: res.failure });
  }, []);

  useEffect(() => {
    void loadUsage();
  }, [loadUsage]);

  useEffect(() => () => abortRef.current?.abort(), []);

  // The mode decides whether the circuit is worth attaching, but the learner
  // keeps the last word once they have touched the checkbox.
  const touchedAttach = useRef(false);
  useEffect(() => {
    if (!touchedAttach.current) setAttach(spec.attachesCircuit);
  }, [spec.attachesCircuit]);

  const context = useMemo(() => {
    if (!mounted || !attach || !hasCircuit) return null;
    return buildCircuitContext({
      circuit,
      stats,
      issues,
      result,
      simError,
      shots,
      seed,
      bindings,
      noiseEnabled,
      noise,
      hash,
    });
  }, [
    mounted, attach, hasCircuit, circuit, stats, issues, result, simError,
    shots, seed, bindings, noiseEnabled, noise, hash,
  ]);

  const composed = useMemo(
    () => composeTutorMessage(intent, draft, context),
    [intent, draft, context],
  );

  const usage = usageState.kind === 'ready' ? usageState.usage : null;
  const signedOut = usageState.kind === 'failed' && usageState.failure.kind === 'unauthenticated';
  const outOfMessages = usage !== null && messagesExhausted(usage);
  const outOfTokens = usage !== null && tokensExhausted(usage);
  const hintLocked = usage?.hintsBlockedByContest === true && intent === 'hint';

  const blocked = signedOut || outOfMessages || outOfTokens || hintLocked;
  const canSend = !blocked && !streaming && draft.trim() !== '';

  useEffect(() => {
    const node = logRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [entries]);

  const send = useCallback(async () => {
    const text = draft.trim();
    if (text === '') return;

    const attachedChars = context?.length ?? 0;
    const userEntry: Entry = {
      id: nextId(), role: 'user', intent, text, attachedChars,
      streaming: false, citations: [], meta: null, usage: null, failure: null, settled: true,
    };
    const answerId = nextId();
    const answerEntry: Entry = {
      id: answerId, role: 'assistant', intent, text: '', attachedChars: 0,
      streaming: true, citations: [], meta: null, usage: null, failure: null, settled: false,
    };

    const history: TutorTurn[] = entries
      .filter((e) => e.text.trim() !== '' && e.failure === null)
      .map((e) => ({ role: e.role, content: e.text }));

    setEntries((prev) => [...prev, userEntry, answerEntry]);
    setDraft('');
    setStreaming(true);

    const controller = new AbortController();
    abortRef.current = controller;

    const patch = (fn: (e: Entry) => Entry) =>
      setEntries((prev) => prev.map((e) => (e.id === answerId ? fn(e) : e)));

    const outcome = await streamTutorMessage(
      {
        intent,
        text,
        context,
        lessonId: lessonId ?? null,
        contestProblemId: contestProblemId ?? null,
        history,
        signal: controller.signal,
      },
      {
        onMeta: (meta) => patch((e) => ({ ...e, meta })),
        onDelta: (_delta, full) => patch((e) => ({ ...e, text: full })),
        onCitations: (found) => patch((e) => ({ ...e, citations: [...e.citations, ...found] })),
        onUsage: (u) => patch((e) => ({ ...e, usage: u })),
      },
    );

    patch((e) => ({
      ...e,
      text: outcome.text,
      citations: outcome.citations,
      meta: outcome.meta,
      usage: outcome.usage,
      failure: outcome.ok ? null : outcome.failure,
      streaming: false,
      settled: true,
    }));

    setStreaming(false);
    abortRef.current = null;
    // The counters the gateway keeps are the only true ones, so re-read them
    // rather than incrementing a local guess.
    void loadUsage();
  }, [draft, context, intent, entries, lessonId, contestProblemId, loadUsage]);

  const composerHint = blocked ? blockId : undefined;

  return (
    <section
      className={`rq-tutor rq-tutor-${variant}`}
      data-register="instrument"
      aria-labelledby={headingId}
    >
      <header className="rq-panel-head rq-tutor-head">
        <h2 id={headingId} className="rq-eyebrow">AI tutor</h2>
        <div className="rq-panel-actions rq-tutor-head-end">
          {usage ? (
            <p className="rq-tutor-budget">
              <span className="rq-numeric">
                {formatCount(usage.messagesToday)}/{formatCount(usage.messagesPerDay)}
              </span>{' '}
              messages today
              <span className="rq-tutor-budget-sep" aria-hidden="true">·</span>
              <span className="rq-numeric">
                {formatCount(usage.tokensToday)}/{formatCount(usage.tokenCeilingPerDay)}
              </span>{' '}
              tokens
              <span className="rq-sr-only"> on the {usage.plan} plan</span>
            </p>
          ) : null}
          {headerExtra}
        </div>
      </header>

      <div className="rq-tutor-notices" id={blockId}>
        {usageState.kind === 'loading' ? <Loading label="your tutor budget" /> : null}

        {signedOut ? (
          <div className="rq-remote rq-remote-error" role="status">
            <p>You are not signed in, so the tutor cannot be reached.</p>
            <p className="rq-remote-hint">
              The gateway needs a session to price a message against your plan.
            </p>
            <p className="rq-tutor-actions">
              <Link className="rq-btn rq-btn-primary rq-btn-sm" href="/login">Sign in</Link>
              <Link className="rq-btn rq-btn-secondary rq-btn-sm" href="/signup">Create an account</Link>
            </p>
          </div>
        ) : null}

        {usageState.kind === 'failed' && usageState.failure.kind === 'network' ? (
          <Unavailable detail={usageState.failure.detail} onRetry={() => void loadUsage()} />
        ) : null}

        {usageState.kind === 'failed' &&
        usageState.failure.kind !== 'network' &&
        usageState.failure.kind !== 'unauthenticated' ? (
          <div className="rq-remote rq-remote-error" role="status">
            <p>{usageState.failure.detail}</p>
            <button type="button" className="rq-btn rq-btn-secondary rq-btn-sm" onClick={() => void loadUsage()}>
              Try again
            </button>
          </div>
        ) : null}

        {usage?.retrievalOnly ? (
          <p className="rq-tutor-banner rq-tutor-banner-info" role="status">
            The tutor is answering from the curriculum only right now
            {usage.cellCostThisHourUsd > 0 ? (
              <>
                {' '}(spend this hour <span className="rq-numeric">{formatUsd(usage.cellCostThisHourUsd)}</span> of{' '}
                <span className="rq-numeric">{formatUsd(usage.hourlyCostCeilingUsd)}</span>)
              </>
            ) : null}
            . Answers will be shorter and will lean on citations.
          </p>
        ) : null}

        {outOfMessages ? (
          <div className="rq-tutor-banner rq-tutor-banner-warn" role="status">
            <p>
              You have used all{' '}
              <span className="rq-numeric">{formatCount(usage?.messagesPerDay ?? 0)}</span> tutor messages
              for today on the {usage?.plan} plan. The counter resets at midnight UTC.
            </p>
            <p className="rq-tutor-actions">
              <Link className="rq-btn rq-btn-secondary rq-btn-sm" href="/pricing">Compare plans</Link>
              <Link className="rq-btn rq-btn-tertiary rq-btn-sm" href="/lab">Keep building in the lab</Link>
            </p>
          </div>
        ) : null}

        {outOfTokens && !outOfMessages ? (
          <div className="rq-tutor-banner rq-tutor-banner-warn" role="status">
            <p>
              You have reached the daily ceiling of{' '}
              <span className="rq-numeric">{formatCount(usage?.tokenCeilingPerDay ?? 0)}</span> tutor tokens.
              It resets at midnight UTC.
            </p>
          </div>
        ) : null}

        {hintLocked ? (
          <div className="rq-tutor-banner rq-tutor-banner-warn" role="status">
            <p>
              Hints are off while you are registered in a running rated contest. That is an integrity
              rule, not a quota, so it cannot be lifted by a plan.
            </p>
            <p className="rq-tutor-actions">
              <button type="button" className="rq-btn rq-btn-secondary rq-btn-sm" onClick={() => setIntent('explain')}>
                Switch to explain
              </button>
              <Link className="rq-btn rq-btn-tertiary rq-btn-sm" href="/contests">Your contests</Link>
            </p>
          </div>
        ) : null}
      </div>

      <div className="rq-tabs rq-tutor-modes" role="tablist" aria-label="Tutor mode">
        {TUTOR_INTENTS.map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={intent === item.id}
            className={`rq-tab${intent === item.id ? ' is-active' : ''}`}
            onClick={() => setIntent(item.id)}
          >
            {item.label}
          </button>
        ))}
      </div>
      <p className="rq-tutor-blurb">{spec.blurb}</p>

      <div
        className="rq-tutor-log"
        role="log"
        tabIndex={0}
        aria-label="Tutor conversation"
        aria-live="polite"
        aria-busy={streaming}
        ref={logRef}
      >
        {entries.length === 0 ? (
          <p className="rq-empty">
            Nothing asked yet. Pick a mode, and if your circuit is the subject, leave the circuit
            attached so the answer is about the gates you actually placed.
          </p>
        ) : (
          entries.map((entry) => <TurnView key={entry.id} entry={entry} />)
        )}
      </div>

      <form
        className="rq-tutor-composer"
        onSubmit={(e) => {
          e.preventDefault();
          if (canSend) void send();
        }}
      >
        <label className="rq-tutor-label" htmlFor={inputId}>{spec.prompt}</label>
        <textarea
          id={inputId}
          className="rq-tutor-input"
          rows={variant === 'dock' ? 3 : 4}
          value={draft}
          disabled={blocked}
          {...(composerHint ? { 'aria-describedby': composerHint } : {})}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && canSend) {
              e.preventDefault();
              void send();
            }
          }}
        />

        <div className="rq-tutor-composer-row">
          <label className="rq-tutor-attach">
            <input
              type="checkbox"
              checked={attach && hasCircuit}
              disabled={!hasCircuit}
              onChange={(e) => {
                touchedAttach.current = true;
                setAttach(e.target.checked);
              }}
            />
            {hasCircuit
              ? `Attach my circuit (${stats.qubits} qubits, depth ${stats.depth})`
              : 'Attach my circuit (nothing placed yet)'}
          </label>

          <span className="rq-numeric rq-tutor-chars">
            {formatCount(composed.message.length)}/{formatCount(TUTOR_MESSAGE_MAX)}
          </span>

          <div className="rq-panel-actions">
            {streaming ? (
              <button
                type="button"
                className="rq-btn rq-btn-secondary rq-btn-sm"
                onClick={() => abortRef.current?.abort()}
              >
                Stop
              </button>
            ) : null}
            <button type="submit" className="rq-btn rq-btn-primary rq-btn-sm" disabled={!canSend}>
              {streaming ? 'Answering...' : 'Ask'}
            </button>
          </div>
        </div>

        {mounted && !hasCircuit ? (
          <p className="rq-tutor-warn">
            No gates are placed yet, so there is no circuit to attach. Build one in the{' '}
            <Link className="rq-lesson-a" href="/lab">lab</Link>, or open this panel from inside it.
          </p>
        ) : null}

        {composed.contextTruncated ? (
          <p className="rq-tutor-warn">
            The circuit is longer than the gateway's{' '}
            <span className="rq-numeric">{formatCount(TUTOR_MESSAGE_MAX)}</span> character limit, so the
            tail of it will be cut. Your question is kept whole.
          </p>
        ) : null}

        {mounted && composed.contextIncluded ? (
          <details className="rq-tutor-preview">
            <summary>What gets sent</summary>
            <pre
              className="rq-tutor-pre"
              tabIndex={0}
              role="region"
              aria-label="Exact message that will be sent"
            >
              {composed.message}
            </pre>
          </details>
        ) : null}
      </form>
    </section>
  );
}

/* ------------------------------------------------------------------- turn -- */

function TurnView({ entry }: { entry: Entry }) {
  if (entry.role === 'user') {
    return (
      <article className="rq-tutor-turn" data-role="user">
        <p className="rq-tutor-role">
          You <span className="rq-tutor-mode">{intentSpec(entry.intent).label}</span>
        </p>
        <p className="rq-tutor-text">{entry.text}</p>
        {entry.attachedChars > 0 ? (
          <p className="rq-tutor-attached">
            Circuit and simulator output attached,{' '}
            <span className="rq-numeric">{formatCount(entry.attachedChars)}</span> characters.
          </p>
        ) : null}
      </article>
    );
  }

  const empty = entry.settled && entry.text.trim() === '';

  return (
    <article className="rq-tutor-turn" data-role="assistant">
      <p className="rq-tutor-role">
        Tutor
        {entry.meta?.retrievalOnly ? <span className="rq-tag rq-tutor-flag">retrieval only</span> : null}
      </p>

      {entry.streaming && entry.text === '' ? (
        <p className="rq-tutor-waiting">Waiting for the first token...</p>
      ) : null}

      {entry.text !== '' ? <p className="rq-tutor-text">{entry.text}</p> : null}

      {empty && entry.failure === null ? (
        <p className="rq-tutor-warn">
          The stream finished without any text. Nothing was generated, so there is nothing to show.
        </p>
      ) : null}

      {entry.failure ? <FailureView failure={entry.failure} partial={entry.text !== ''} /> : null}

      {entry.settled && entry.failure === null ? <Citations citations={entry.citations} /> : null}

      {entry.usage ? (
        <p className="rq-tutor-turn-usage">
          <span className="rq-numeric">{formatCount(entry.usage.inputTokens)}</span> in,{' '}
          <span className="rq-numeric">{formatCount(entry.usage.outputTokens)}</span> out,{' '}
          <span className="rq-numeric">{formatUsd(entry.usage.costUsd)}</span>
        </p>
      ) : null}
    </article>
  );
}

function Citations({ citations }: { citations: TutorCitation[] }) {
  if (citations.length === 0) {
    return (
      <p className="rq-tutor-nocite">
        No lesson citation came back with this answer. Treat it as unsourced and check it against the
        curriculum before you rely on it.
      </p>
    );
  }

  return (
    <>
      <p className="rq-eyebrow rq-tutor-cite-head">Cited lessons</p>
      <ul className="rq-tutor-cites">
        {citations.map((c, i) => (
          <li key={`${c.href ?? c.title}-${i}`}>
            {c.href === null ? (
              <span className="rq-tutor-cite-flat">
                {c.title} <span className="rq-tutor-cite-note">(no lesson link resolved)</span>
              </span>
            ) : c.external ? (
              <a className="rq-lesson-a" href={c.href} rel="noreferrer noopener" target="_blank">
                {c.title} <span className="rq-tutor-cite-note">(external)</span>
              </a>
            ) : (
              <Link className="rq-lesson-a" href={c.href}>{c.title}</Link>
            )}
            {c.score !== null ? (
              <span className="rq-numeric rq-tutor-cite-score">{c.score.toFixed(2)}</span>
            ) : null}
            {c.quote ? <span className="rq-tutor-cite-quote">{c.quote}</span> : null}
          </li>
        ))}
      </ul>
    </>
  );
}

function FailureView({ failure, partial }: { failure: TutorFailure; partial: boolean }) {
  const lead = partial ? 'The answer stopped here. ' : '';

  if (failure.kind === 'cancelled') {
    return <p className="rq-tutor-warn">{lead}You stopped it.</p>;
  }

  return (
    <div className="rq-tutor-failure" role="status">
      <p>{lead}{failure.detail}</p>
      <p className="rq-tutor-actions">
        {failure.kind === 'unauthenticated' ? (
          <Link className="rq-btn rq-btn-secondary rq-btn-sm" href="/login">Sign in</Link>
        ) : null}
        {failure.kind === 'budget-exhausted' || failure.kind === 'message-limit' ? (
          <Link className="rq-btn rq-btn-secondary rq-btn-sm" href="/pricing">Compare plans</Link>
        ) : null}
        {failure.kind === 'contest-lock' ? (
          <Link className="rq-btn rq-btn-secondary rq-btn-sm" href="/contests">Your contests</Link>
        ) : null}
      </p>
      {failure.kind === 'network' || failure.kind === 'upstream' ? (
        <p className="rq-remote-hint">
          The tutor sits behind the gateway, which proxies to a separate ai-tutor worker. Both must be
          running: <code className="rq-lesson-code">pnpm --filter @redquant/api dev</code>, and the
          worker on <code className="rq-lesson-code">AI_TUTOR_URL</code>. If the gateway is up and this
          still fails, check that this origin is in{' '}
          <code className="rq-lesson-code">CORS_ALLOWED_ORIGINS</code> and that the stream response
          carries the matching header.
        </p>
      ) : null}
      {failure.kind === 'message-limit' && failure.retryAfterSeconds !== null ? (
        <p className="rq-remote-hint">
          The bucket refills in{' '}
          <span className="rq-numeric">{Math.ceil(failure.retryAfterSeconds / 60)}</span> minutes.
        </p>
      ) : null}
    </div>
  );
}
