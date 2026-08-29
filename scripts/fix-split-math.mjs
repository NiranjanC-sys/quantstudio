#!/usr/bin/env node
/**
 * Joins inline math spans that were wrapped across a line break.
 *
 * remark-math only tokenises `$...$` within a single line, so a wrapped span
 * leaves its opening `$` unclosed and every `\begin{...}` after it reaches the
 * JavaScript parser. The fix is purely mechanical: while a line carries an odd
 * number of unescaped `$`, pull the next line up onto it.
 *
 * Frontmatter, fenced code and `$$` display blocks are skipped, because a `$`
 * inside them is not a math delimiter.
 */

import fs from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve(process.argv[2] ?? 'content/tracks');
let filesChanged = 0;
let joins = 0;

const odd = (s) => ((s.match(/(?<!\\)\$/g) ?? []).length % 2) === 1;

async function walk(dir) {
  for (const e of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) await walk(full);
    else if (e.name.endsWith('.mdx')) await fix(full);
  }
}

async function fix(file) {
  const original = await fs.readFile(file, 'utf8');
  const lines = original.split('\n');
  const out = [];

  let fm = 0;
  let inFence = false;
  let inBlock = false;
  let localJoins = 0;

  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];

    if (line.trim() === '---' && fm < 2) { fm++; out.push(line); continue; }
    if (fm === 1) { out.push(line); continue; }
    if (/^\s*```/.test(line)) { inFence = !inFence; out.push(line); continue; }
    if (inFence) { out.push(line); continue; }
    if (/^\s*\$\$\s*$/.test(line)) { inBlock = !inBlock; out.push(line); continue; }
    if (inBlock) { out.push(line); continue; }

    // Pull continuation lines up while the span is still open.
    let guard = 0;
    while (odd(line) && i + 1 < lines.length && guard < 6) {
      const next = lines[i + 1];
      // Never swallow a blank line, a fence, or a display-math delimiter: an
      // odd $ before one of those is a different bug, and joining would hide it.
      if (next.trim() === '' || /^\s*```/.test(next) || /^\s*\$\$/.test(next)) break;
      line = line.replace(/\s*$/, '') + ' ' + next.replace(/^\s*/, '');
      i++;
      guard++;
      localJoins++;
    }
    out.push(line);
  }

  if (localJoins > 0) {
    await fs.writeFile(file, out.join('\n'));
    filesChanged++;
    joins += localJoins;
    console.log(`  ${path.relative(process.cwd(), file)}: ${localJoins} join(s)`);
  }
}

await walk(ROOT);
console.log(`\njoined ${joins} wrapped math span(s) across ${filesChanged} file(s)`);
