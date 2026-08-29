'use client';

import { useCallback, useEffect, useState } from 'react';
import { api, type LeaderboardRow, type Page } from '@/lib/api';
import { Loading, Unavailable, Empty } from './RemoteState';

type Board = 'global' | 'ratings';

export function Leaderboard() {
  const [board, setBoard] = useState<Board>('global');
  const [state, setState] = useState<
    { kind: 'loading' } | { kind: 'error'; detail: string } | { kind: 'ready'; page: Page<LeaderboardRow> }
  >({ kind: 'loading' });

  const load = useCallback(async (which: Board) => {
    setState({ kind: 'loading' });
    const res = await api<Page<LeaderboardRow>>(`/leaderboard/${which}?limit=50`);
    setState(res.ok ? { kind: 'ready', page: res.data } : { kind: 'error', detail: res.detail });
  }, []);

  useEffect(() => {
    void load(board);
  }, [board, load]);

  return (
    <>
      <div className="rq-tabs rq-tabs-lg" role="tablist" aria-label="Leaderboard">
        {(['global', 'ratings'] as Board[]).map((b) => (
          <button
            key={b}
            role="tab"
            aria-selected={board === b}
            className={`rq-tab${board === b ? ' is-active' : ''}`}
            onClick={() => setBoard(b)}
          >
            {b === 'global' ? 'Experience' : 'Contest rating'}
          </button>
        ))}
      </div>

      {state.kind === 'loading' && <Loading label="the leaderboard" />}
      {state.kind === 'error' && <Unavailable detail={state.detail} onRetry={() => void load(board)} />}
      {state.kind === 'ready' &&
        (state.page.items.length === 0 ? (
          <Empty>Nobody has scored yet. Be the first.</Empty>
        ) : (
          <table className="rq-board">
            <caption className="rq-sr-only">
              Top {state.page.items.length} of {state.page.total} by{' '}
              {board === 'global' ? 'experience' : 'contest rating'}
            </caption>
            <thead>
              <tr>
                <th scope="col">Rank</th>
                <th scope="col">Learner</th>
                <th scope="col">Institution</th>
                <th scope="col">{board === 'global' ? 'XP' : 'Rating'}</th>
              </tr>
            </thead>
            <tbody>
              {state.page.items.map((row) => (
                <tr key={row.userId}>
                  <td className="rq-numeric rq-board-rank">{row.rank}</td>
                  <th scope="row">{row.displayName ?? row.username ?? `Learner ${row.userId}`}</th>
                  <td className="rq-board-inst">{row.institution ?? ''}</td>
                  <td className="rq-numeric rq-board-score">{row.score.toLocaleString('en')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ))}
    </>
  );
}
