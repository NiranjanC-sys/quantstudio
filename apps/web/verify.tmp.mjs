import { chromium } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import fs from 'node:fs';

const BASE = 'http://localhost:3210';
const COHORT = '0b175e46-aecc-4d90-aebd-5ca3f1ad2b3e';
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

const jar = fs.readFileSync('/tmp/rq.jar', 'utf8');
const cookies = jar.split('\n').filter(l => l.includes('rq_')).map(l => {
  const p = l.replace('#HttpOnly_', '').split('\t');
  return { name: p[5], value: p[6], domain: 'localhost', path: '/' };
});

const browser = await chromium.launch();
let failures = 0;

async function scan(page, name) {
  const r = await new AxeBuilder({ page }).withTags(TAGS).exclude('.rq-bloch canvas').analyze();
  const v = r.violations.map(x => `${x.id} (${x.impact}): ${x.nodes.length} node(s) - ${x.help}\n      ${x.nodes.slice(0,2).map(n=>n.html.slice(0,160)).join('\n      ')}`);
  if (v.length) { failures++; console.log(`  VIOLATIONS ${name}:\n    ${v.join('\n    ')}`); }
  else console.log(`  ok ${name}`);
}

for (const theme of ['light', 'dark']) {
  for (const authed of [false, true]) {
    const ctx = await browser.newContext();
    if (authed) await ctx.addCookies(cookies);
    const page = await ctx.newPage();
    await page.emulateMedia({ colorScheme: theme });
    const tag = `${theme}/${authed ? 'instructor' : 'signed-out'}`;
    console.log(`--- ${tag} ---`);

    const set = async (path) => {
      await page.goto(BASE + path);
      await page.evaluate(t => document.documentElement.setAttribute('data-theme', t), theme);
      await page.waitForTimeout(900);
    };

    await set('/instructor');
    console.log('  /instructor text:', (await page.locator('main').innerText()).replace(/\n/g,' | ').slice(0, 220));
    await scan(page, '/instructor');

    await set(`/instructor/${COHORT}`);
    console.log('  cohort text:', (await page.locator('main').innerText()).replace(/\n/g,' | ').slice(0, 200));
    await scan(page, 'cohort roster');

    if (authed) {
      for (const tab of ['Mastery', 'Assignments', 'Gradebook']) {
        await page.getByRole('tab', { name: tab }).click();
        await page.waitForTimeout(1200);
        await scan(page, `cohort ${tab}`);
      }
      // heatmap sanity
      await page.getByRole('tab', { name: 'Mastery' }).click();
      await page.waitForTimeout(900);
      console.log('  heatmap rows:', await page.locator('.rq-heat tbody tr').count(),
                  'cells:', await page.locator('.rq-heat-cell').count(),
                  'absent:', await page.locator('.rq-heat-cell.is-absent').count());
      // expand the assignment form so its fields are scanned too
      await page.getByRole('tab', { name: 'Assignments' }).click();
      await page.waitForTimeout(600);
      await page.getByRole('button', { name: 'New assignment' }).click();
      await page.waitForTimeout(600);
      await page.locator('#pick-track').selectOption('T1');
      await page.waitForTimeout(900);
      await page.locator('#pick-module').selectOption('T1.M1');
      await page.waitForTimeout(900);
      console.log('  lesson options:', await page.locator('.rq-ins-lesson-list li').count());
      await scan(page, 'assignment form + lesson picker');
    }

    await set('/billing');
    console.log('  /billing text:', (await page.locator('main').innerText()).replace(/\n/g,' | ').slice(0, 260));
    await scan(page, '/billing');

    await set('/billing/success?session=cs_test_123');
    await scan(page, '/billing/success');
    await set('/billing/cancelled');
    await scan(page, '/billing/cancelled');

    await ctx.close();
  }
}

console.log(failures === 0 ? 'AXE: no violations' : `AXE: ${failures} pages with violations`);
await browser.close();
