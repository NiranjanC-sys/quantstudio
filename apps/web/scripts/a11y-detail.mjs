import { chromium } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

const routes = ['/', '/curriculum', '/pricing', '/login', '/lab', '/interview', '/learn/t0/m1/l1-bits-and-states'];
const browser = await chromium.launch();
const seen = new Map();

for (const theme of ['light', 'dark']) {
  const context = await browser.newContext({ colorScheme: theme });
  const page = await context.newPage();
  for (const path of routes) {
    await page.goto('http://localhost:3210' + path);
    await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme);
    const r = await new AxeBuilder({ page }).withTags(['wcag2a','wcag2aa','wcag21a','wcag21aa']).exclude('.rq-bloch canvas').analyze();
    for (const v of r.violations) {
      for (const n of v.nodes) {
        const key = `${v.id}|${n.target.join(' ')}`;
        if (seen.has(key)) continue;
        seen.set(key, { theme, path, id: v.id, target: n.target.join(' '), msg: (n.any[0]?.message ?? n.all[0]?.message ?? v.help).slice(0, 180) });
      }
    }
  }
  await context.close();
}
await browser.close();
for (const v of seen.values()) {
  console.log(`[${v.id}] ${v.theme} ${v.path}\n   ${v.target}\n   ${v.msg}\n`);
}
console.log('distinct issues:', seen.size);
