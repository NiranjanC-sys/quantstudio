import fs from 'node:fs/promises';
import path from 'node:path';
import { parse } from 'yaml';
import { CONTENT_ROOT } from './content';

/**
 * Contest metadata, read off disk.
 *
 * Live standings come from the API (Redis sorted sets, see system-design
 * section 6). This loader only supplies the static half: which contests exist,
 * what their problems are, and when they run.
 */

export interface ContestProblem {
  id: string;
  title: string;
  points: number;
  difficulty?: string;
  summary?: string;
}

export interface Contest {
  id: string;
  title: string;
  date: string;
  durationMinutes: number;
  ratingRange?: string;
  summary?: string;
  problems: ContestProblem[];
}

async function readContest(dir: string, id: string): Promise<Contest | null> {
  try {
    const raw = await fs.readFile(path.join(dir, id, 'meta.yaml'), 'utf8');
    const doc = parse(raw) as Partial<Contest> | null;
    if (!doc?.id) return null;
    return {
      id: doc.id,
      title: doc.title ?? doc.id,
      date: doc.date ?? '',
      durationMinutes: doc.durationMinutes ?? 90,
      ratingRange: doc.ratingRange,
      summary: doc.summary,
      problems: doc.problems ?? [],
    };
  } catch {
    return null;
  }
}

export async function getContest(id: string): Promise<Contest | null> {
  // Reject any id that could escape the contests directory.
  if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) return null;
  return readContest(path.join(CONTENT_ROOT, 'contests'), id);
}

export async function listContests(): Promise<Contest[]> {
  const dir = path.join(CONTENT_ROOT, 'contests');
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: Contest[] = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const c = await readContest(dir, e.name);
    if (c) out.push(c);
  }
  return out.sort((a, b) => b.date.localeCompare(a.date));
}
