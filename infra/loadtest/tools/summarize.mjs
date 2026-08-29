/**
 * summarize.mjs <label> — collapses one run's k6 summary and its sysmon stream
 * into the row that goes into the report.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const R = join(HERE, '..', 'results');
const label = process.argv[2];

const sPath = join(R, `${label}-summary.json`);
if (!existsSync(sPath)) { console.error(`[summarize] no ${sPath}`); process.exit(0); }
const m = JSON.parse(readFileSync(sPath, 'utf8')).metrics;

const fmt = (x) => (x === undefined || x === null ? '-' : x < 10 ? x.toFixed(2) : Math.round(x).toString());
const row = (name, t, e, r) => {
  const tv = m[t]?.values;
  if (!tv) return null;
  const ev = m[e]?.values;
  const rv = m[r]?.values;
  const n = (ev?.passes ?? 0) + (ev?.fails ?? 0);
  return {
    endpoint: name,
    n,
    p50: fmt(tv.med), p95: fmt(tv['p(95)']), p99: fmt(tv['p(99)']), max: fmt(tv.max),
    errPct: ev ? (ev.rate * 100).toFixed(2) : '-',
    rlPct: rv ? (rv.rate * 100).toFixed(2) : '-',
  };
};

const rows = [
  row('GET  /catalog/lessons/:slug', 'lat_read_lesson', 'err_read_lesson', 'rl_read'),
  row('GET  /progress/overview', 'lat_dashboard', 'err_dashboard', 'rl_dashboard'),
  row('POST /simulate', 'lat_simulate', 'err_simulate', 'rl_simulate'),
  row('POST /labs/submit', 'lat_lab_submit', 'err_lab_submit', 'rl_lab_submit'),
  row('POST /contests/:slug/submit', 'lat_contest_submit', 'err_contest_submit', 'rl_contest_submit'),
  row('simulation (sim-capacity)', 'sim_latency', 'sim_ok', 'sim_ok'),
].filter(Boolean);

console.log(`\n=== ${label} ===`);
console.log(`achieved throughput: ${m.http_reqs?.values.rate?.toFixed(1)} req/s over ${m.http_reqs?.values.count} requests`);
console.log(
  'endpoint'.padEnd(30) + 'n'.padStart(8) + 'p50ms'.padStart(9) + 'p95ms'.padStart(9)
  + 'p99ms'.padStart(9) + 'maxms'.padStart(9) + 'err%'.padStart(8) + '429%'.padStart(8),
);
for (const r of rows) {
  console.log(
    r.endpoint.padEnd(30) + String(r.n).padStart(8) + r.p50.padStart(9) + r.p95.padStart(9)
    + r.p99.padStart(9) + r.max.padStart(9) + r.errPct.padStart(8) + r.rlPct.padStart(8),
  );
}
for (const k of ['sim_upstream_unavailable', 'entitlement_denials', 'credits_exhausted', 'sim_cache_hit_rate', 'sim_503_upstream', 'rate_limited_total']) {
  if (m[k]) console.log(`  ${k}: ${JSON.stringify(m[k].values)}`);
}

const mon = join(R, `${label}-sysmon.jsonl`);
if (existsSync(mon)) {
  const samples = readFileSync(mon, 'utf8').trim().split('\n').map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  // Drop the first two samples: the first has no delta, the second straddles startup.
  const s = samples.slice(2);
  if (s.length) {
    const pick = (f) => s.map(f).filter((v) => typeof v === 'number' && !Number.isNaN(v));
    const stat = (arr) => arr.length ? { med: arr.slice().sort((a, b) => a - b)[Math.floor(arr.length / 2)], max: Math.max(...arr) } : null;
    const out = {
      samples: s.length,
      hostCpuPct: stat(pick((x) => x.hostCpuPct)),
      gatewayCpuPct: stat(pick((x) => x.gateway?.cpuPct)),
      kernelCpuPct: stat(pick((x) => x.kernel?.cpuPct)),
      webCpuPct: stat(pick((x) => x.web?.cpuPct)),
      gatewayRssMb: stat(pick((x) => x.gateway?.rssMb)),
      kernelRssMb: stat(pick((x) => x.kernel?.rssMb)),
      eventLoopLagP99Ms: stat(pick((x) => x.gw?.elLagP99Ms)),
      eventLoopLagMaxMs: stat(pick((x) => x.gw?.elLagMaxMs)),
      pgActive: stat(pick((x) => x.pg?.active)),
      pgBackends: stat(pick((x) => x.pg?.backends)),
      pgLockWaits: stat(pick((x) => x.pg?.lockWaits)),
      pgCommitsPerSec: stat(pick((x) => x.pg?.commitsPerSec)),
      redisOpsPerSec: stat(pick((x) => x.redis?.opsPerSec)),
      redisClients: stat(pick((x) => x.redis?.clients)),
    };
    console.log('\nresources (median / max over the run):');
    for (const [k, v] of Object.entries(out)) {
      if (v && typeof v === 'object') console.log(`  ${k.padEnd(20)} ${String(v.med).padStart(8)} / ${String(v.max).padStart(8)}`);
      else console.log(`  ${k.padEnd(20)} ${v}`);
    }
  }
}
