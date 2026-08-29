import fs from 'node:fs/promises';
import path from 'node:path';
import matter from 'gray-matter';
import { parse as parseYaml } from 'yaml';

/**
 * Filesystem access to the authored curriculum.
 *
 * Lessons live in `content/tracks/<track>/<module>/<slug>.mdx` outside the app
 * directory so that content authors never touch application code, and so the
 * same files can be validated by the content package's schema tests.
 */

export const CONTENT_ROOT = path.join(process.cwd(), '..', '..', 'content');

/** The one directory a lesson may ever be read from. */
const TRACKS_ROOT = path.resolve(CONTENT_ROOT, 'tracks');

/**
 * A lesson slug segment.
 *
 * Deliberately narrow rather than a traversal blocklist: `..`, an absolute
 * path, a backslash, a NUL and every percent-encoded spelling of them all fail
 * the same shape check, so there is nothing to enumerate.
 */
const SLUG_SEGMENT = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,80}$/;

function safeLessonPath(slug: string[]): string | null {
  if (!Array.isArray(slug) || slug.length === 0 || slug.length > 8) return null;
  for (const segment of slug) {
    if (typeof segment !== 'string') return null;
    if (segment === '.' || segment === '..') return null;
    if (!SLUG_SEGMENT.test(segment)) return null;
  }
  const resolved = path.resolve(TRACKS_ROOT, ...slug) + '.mdx';
  // Belt and braces. `path.relative` is the containment test that a string
  // prefix is not: `content/tracks-private` shares a prefix with
  // `content/tracks` but is not inside it.
  const rel = path.relative(TRACKS_ROOT, resolved);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return resolved;
}

/**
 * gray-matter parses `---js` front matter by *running* it through `eval`.
 * Curriculum files are authored by people who never touch application code, so
 * a lesson must not be able to execute anything in the rendering process. Only
 * YAML and JSON front matter is accepted; every other engine is refused.
 */
const deniedEngine = (language: string) => () => {
  throw new Error(`front matter language '${language}' is not allowed in curriculum content`);
};

const MATTER_OPTIONS = {
  language: 'yaml',
  engines: {
    yaml: { parse: (s: string) => (parseYaml(s) ?? {}) as object, stringify: () => '' },
    json: { parse: (s: string) => JSON.parse(s) as object, stringify: (o: object) => JSON.stringify(o) },
    javascript: deniedEngine('javascript'),
    js: deniedEngine('js'),
    coffee: deniedEngine('coffee'),
    toml: deniedEngine('toml'),
  },
};

/** Front matter + body, with the unsafe gray-matter engines disabled. */
function readMatter(raw: string): { data: unknown; content: string } {
  const { data, content } = matter(raw, MATTER_OPTIONS as Parameters<typeof matter>[1]);
  return { data, content };
}

export interface LessonSource {
  label: string;
  url?: string;
}

export interface LessonFrontmatter {
  id: string;
  title: string;
  type: 'concept' | 'interactive' | 'lab' | 'drill' | 'checkpoint' | 'project';
  minutes?: number;
  level?: string;
  objectives?: string[];
  prerequisites?: string[];
  sources?: LessonSource[];
  summary?: string;
}

export interface Lesson {
  slug: string[];
  frontmatter: LessonFrontmatter;
  body: string;
}

async function walk(dir: string): Promise<string[]> {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(full)));
    else if (e.name.endsWith('.mdx')) out.push(full);
  }
  return out;
}

export async function listLessons(): Promise<Lesson[]> {
  const files = await walk(path.join(CONTENT_ROOT, 'tracks'));
  const lessons: Lesson[] = [];
  for (const file of files) {
    try {
      const raw = await fs.readFile(file, 'utf8');
      const { data, content } = readMatter(raw);
      const rel = path.relative(path.join(CONTENT_ROOT, 'tracks'), file).replace(/\.mdx$/, '');
      lessons.push({
        slug: rel.split(path.sep),
        frontmatter: data as LessonFrontmatter,
        body: content,
      });
    } catch (e) {
      // One unparseable (or deliberately hostile) file must not blank the whole
      // curriculum index.
      console.warn(`content: skipping ${file}: ${(e as Error).message}`);
    }
  }
  return lessons.sort((a, b) => a.slug.join('/').localeCompare(b.slug.join('/')));
}

export async function getLesson(slug: string[]): Promise<Lesson | null> {
  // The body of whatever this reads is handed to MDX, which compiles and runs
  // it on the server, so "which file" is a code-execution decision, not just a
  // read. Hence a shape allowlist and a real containment check rather than a
  // string prefix, which `content/tracks-anything` used to walk straight past.
  const resolved = safeLessonPath(slug);
  if (!resolved) return null;
  try {
    const raw = await fs.readFile(resolved, 'utf8');
    const { data, content } = readMatter(raw);
    return { slug, frontmatter: data as LessonFrontmatter, body: content };
  } catch {
    return null;
  }
}

/** Reading time at 210 words per minute, rounded up, minimum one. */
export function readingMinutes(body: string): number {
  const words = body.trim().split(/\s+/).length;
  return Math.max(1, Math.ceil(words / 210));
}
