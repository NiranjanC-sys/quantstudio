#!/usr/bin/env node
/**
 * Content validator.
 *
 * This used to guess. It flagged every inline `$...$` span that wrapped across
 * a line, on the theory that remark-math cannot tokenise across a line break.
 * That theory is wrong: remark-math handles a soft line break fine, and the
 * rule produced fourteen false positives on lessons that render perfectly.
 *
 * So it no longer guesses. It compiles every file through the exact pipeline
 * the app uses and reports what actually fails, then applies the handful of
 * style rules a compiler cannot know about.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { compile } from '@mdx-js/mdx';
import remarkMath from 'remark-math';
import remarkGfm from 'remark-gfm';
import rehypeKatex from 'rehype-katex';
import matter from 'gray-matter';

const ROOT = path.resolve(process.argv[2] ?? 'content/tracks');

/** Dirac macros, mirroring apps/web/lib/katex-macros.ts. */
const MACROS = {
  '\\ket': '\\left|#1\\right\\rangle',
  '\\bra': '\\left\\langle#1\\right|',
  '\\braket': '\\left\\langle#1\\middle|#2\\right\\rangle',
  '\\ketbra': '\\left|#1\\right\\rangle\\!\\left\\langle#2\\right|',
  '\\expect': '\\left\\langle#1\\right\\rangle',
  '\\tr': '\\operatorname{Tr}',
  '\\Hgate': '\\mathrm{H}',
  '\\CNOT': '\\mathrm{CNOT}',
  '\\dg': '^{\\dagger}',
  '\\half': '\\tfrac{1}{2}',
  '\\isqrt': '\\tfrac{1}{\\sqrt{2}}',
  '\\C': '\\mathbb{C}',
  '\\R': '\\mathbb{R}',
  '\\Z': '\\mathbb{Z}',
  '\\N': '\\mathbb{N}',
};

const problems = [];
let checked = 0;

async function walk(dir) {
  for (const e of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) await walk(full);
    else if (e.name.endsWith('.mdx')) await check(full);
  }
}

async function check(file) {
  const rel = path.relative(process.cwd(), file);
  const raw = await fs.readFile(file, 'utf8');
  checked++;

  let parsed;
  try {
    parsed = matter(raw);
  } catch (e) {
    problems.push({ file: rel, line: 1, rule: 'frontmatter', detail: e.message });
    return;
  }
  if (Object.keys(parsed.data).length === 0) {
    problems.push({ file: rel, line: 1, rule: 'frontmatter', detail: 'No frontmatter found.' });
  }

  // The authoritative check: does it compile the way the app compiles it?
  try {
    await compile(parsed.content, {
      remarkPlugins: [remarkMath, remarkGfm],
      rehypePlugins: [[rehypeKatex, { macros: MACROS, throwOnError: true, strict: false }]],
    });
  } catch (e) {
    const line = e.line ?? e.place?.start?.line ?? 1;
    problems.push({
      file: rel,
      line,
      rule: 'compile',
      detail: String(e.message).split('\n')[0],
    });
  }

  // Style rules the compiler has no opinion about.
  parsed.content.split('\n').forEach((ln, i) => {
    if (/[—–]/.test(ln)) {
      problems.push({
        file: rel,
        line: i + 1,
        rule: 'dash',
        detail: 'Em or en dash in copy. Use a comma, a colon, or rewrite.',
      });
    }
  });
}

await walk(ROOT);

const scope = path.relative(process.cwd(), ROOT);
if (problems.length === 0) {
  console.log(`content: ${checked} file(s) under ${scope} compile cleanly, no style problems`);
  process.exit(0);
}
const byRule = new Map();
for (const p of problems) byRule.set(p.rule, (byRule.get(p.rule) ?? 0) + 1);
for (const p of problems) console.log(`${p.file}:${p.line}  [${p.rule}] ${p.detail}`);
console.log(
  `\n${problems.length} problem(s) in ${checked} file(s): ` +
    [...byRule].map(([r, c]) => `${r} ${c}`).join(', '),
);
process.exit(1);
