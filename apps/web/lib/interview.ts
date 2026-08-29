import fs from 'node:fs/promises';
import path from 'node:path';
import { parse } from 'yaml';
import { CONTENT_ROOT } from './content';

/**
 * Reads the interview bank off disk.
 *
 * The YAML is authored by subject-matter writers and validated in
 * packages/content, so this loader is deliberately tolerant: a malformed file
 * is skipped with a warning rather than taking the whole page down.
 */

export interface InterviewQuestion {
  id: string;
  title: string;
  kind?: 'coding' | 'system-design' | 'concept';
  prompt: string;
  difficulty: 'easy' | 'medium' | 'hard';
  pattern?: string;
  topics: string[];
  companies: string[];
  modelAnswer?: string;
  answer?: string;
  followups?: string[];
  mistakes?: string[];
  references?: { label: string; url?: string }[];
}

export interface Company {
  id: string;
  name: string;
  modality: string;
  primarySdk: string;
  asks: string[];
  roles: string[];
  links: { label: string; url: string }[];
  notes?: string;
}

const INTERVIEW_DIR = path.join(CONTENT_ROOT, 'interview');

export async function listQuestions(): Promise<InterviewQuestion[]> {
  const dir = path.join(INTERVIEW_DIR, 'questions');
  let files: string[];
  try {
    files = (await fs.readdir(dir)).filter((f) => f.endsWith('.yaml') || f.endsWith('.yml'));
  } catch {
    return [];
  }
  const out: InterviewQuestion[] = [];
  for (const f of files) {
    try {
      const doc = parse(await fs.readFile(path.join(dir, f), 'utf8')) as { questions?: InterviewQuestion[] } | null;
      for (const q of doc?.questions ?? []) {
        if (q?.id && q.title) out.push(q);
      }
    } catch (e) {
      console.warn(`interview: skipping ${f}: ${(e as Error).message}`);
    }
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

export async function getQuestion(id: string): Promise<InterviewQuestion | null> {
  const all = await listQuestions();
  return all.find((q) => q.id === id) ?? null;
}

export async function listCompanies(): Promise<Company[]> {
  try {
    const raw = await fs.readFile(path.join(INTERVIEW_DIR, 'companies.yaml'), 'utf8');
    const doc = parse(raw) as { companies?: Company[] } | null;
    return (doc?.companies ?? []).filter((c) => c?.id && c.name);
  } catch {
    return [];
  }
}

/** Distinct facet values, with counts, for the filter rail. */
export function facets(questions: InterviewQuestion[]) {
  const count = (pick: (q: InterviewQuestion) => string[]) => {
    const m = new Map<string, number>();
    for (const q of questions) for (const v of pick(q) ?? []) m.set(v, (m.get(v) ?? 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  };
  return {
    companies: count((q) => q.companies ?? []),
    topics: count((q) => q.topics ?? []),
    difficulty: count((q) => [q.difficulty]),
    kind: count((q) => (q.kind ? [q.kind] : [])),
  };
}
