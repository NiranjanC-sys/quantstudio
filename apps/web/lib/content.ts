import fs from 'node:fs/promises';
import path from 'node:path';
import matter from 'gray-matter';

/**
 * Filesystem access to the authored curriculum.
 *
 * Lessons live in `content/tracks/<track>/<module>/<slug>.mdx` outside the app
 * directory so that content authors never touch application code, and so the
 * same files can be validated by the content package's schema tests.
 */

export const CONTENT_ROOT = path.join(process.cwd(), '..', '..', 'content');

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
    const raw = await fs.readFile(file, 'utf8');
    const { data, content } = matter(raw);
    const rel = path.relative(path.join(CONTENT_ROOT, 'tracks'), file).replace(/\.mdx$/, '');
    lessons.push({
      slug: rel.split(path.sep),
      frontmatter: data as LessonFrontmatter,
      body: content,
    });
  }
  return lessons.sort((a, b) => a.slug.join('/').localeCompare(b.slug.join('/')));
}

export async function getLesson(slug: string[]): Promise<Lesson | null> {
  const file = path.join(CONTENT_ROOT, 'tracks', ...slug) + '.mdx';
  // Refuse anything that escapes the content root, so a crafted URL cannot
  // read application source.
  const resolved = path.resolve(file);
  if (!resolved.startsWith(path.resolve(path.join(CONTENT_ROOT, 'tracks')))) return null;
  try {
    const raw = await fs.readFile(resolved, 'utf8');
    const { data, content } = matter(raw);
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
