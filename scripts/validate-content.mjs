#!/usr/bin/env node
/**
 * Content validator.
 *
 * MDX fails at build time with "Could not parse expression with acorn" when a
 * brace reaches the JavaScript parser. The commonest cause in this curriculum
 * is an inline `$...$` span broken across a line: remark-math only tokenises
 * inline math within one line, so the opening `$` never closes and every
 * `\begin{pmatrix}` after it is read as JSX.
 *
 * This catches that, and a few neighbouring hazards, before a build does.
 */

import fs from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve(process.argv[2] ?? 'content/tracks');
const problems = [];

async function walk(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) await walk(full);
    else if (e.name.endsWith('.mdx')) await check(full);
  }
}

function stripInlineMath(line) {
  return line.replace(/\$\$[^$]*\$\$/g, '').replace(/\$[^$\n]*\$/g, '');
}

async function check(file) {
  const rel = path.relative(process.cwd(), file);
  const lines = (await fs.readFile(file, 'utf8')).split('\n');

  let inFrontmatter = false;
  let frontmatterSeen = 0;
  let inBlockMath = false;
  let inFence = false;

  lines.forEach((raw, i) => {
    const n = i + 1;
    const line = raw.trimEnd();

    if (line.trim() === '---' && frontmatterSeen < 2) {
      frontmatterSeen += 1;
      inFrontmatter = frontmatterSeen === 1;
      return;
    }
    if (inFrontmatter) return;

    if (/^\s*```/.test(line)) { inFence = !inFence; return; }
    if (inFence) return;

    if (/^\s*\$\$\s*$/.test(line)) { inBlockMath = !inBlockMath; return; }
    if (inBlockMath) return;

    // An odd number of unescaped `$` on a line means a math span is unterminated
    // and will run into the next line, where MDX will choke on its braces.
    const dollars = (line.match(/(?<!\\)\$/g) ?? []).length;
    if (dollars % 2 === 1) {
      problems.push({ file: rel, line: n, rule: 'unbalanced-inline-math',
        detail: 'Odd number of $ on this line. Inline math cannot span a line break; use a $$ block.' });
    }

    // A brace surviving outside math and outside a component prop is a JSX
    // expression as far as MDX is concerned.
    const bare = stripInlineMath(line);
    if (/[{}]/.test(bare) && !/^\s*(ir=|show=|\{|\}|[a-zA-Z]+=\{|<|\/>|\]|\)|,)/.test(bare.trim())
        && !/=\{/.test(bare)) {
      problems.push({ file: rel, line: n, rule: 'bare-brace',
        detail: `Brace outside math and outside a prop: ${bare.trim().slice(0, 80)}` });
    }

    // Em and en dashes are banned in product copy by DESIGN.md.
    if (/[—–]/.test(line)) {
      problems.push({ file: rel, line: n, rule: 'dash',
        detail: 'Em or en dash in copy. Use a comma, a colon, or rewrite.' });
    }
  });

  if (frontmatterSeen < 2) {
    problems.push({ file: rel, line: 1, rule: 'frontmatter', detail: 'Missing or unterminated frontmatter.' });
  }
}

await walk(ROOT);

if (problems.length === 0) {
  console.log(`content: no problems found under ${path.relative(process.cwd(), ROOT)}`);
  process.exit(0);
}
const byRule = new Map();
for (const p of problems) byRule.set(p.rule, (byRule.get(p.rule) ?? 0) + 1);
for (const p of problems) console.log(`${p.file}:${p.line}  [${p.rule}] ${p.detail}`);
console.log(`\n${problems.length} problem(s): ${[...byRule].map(([r, c]) => `${r} ${c}`).join(', ')}`);
process.exit(1);
