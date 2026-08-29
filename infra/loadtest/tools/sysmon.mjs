/**
 * sysmon.mjs — samples "which resource ran out" once a second during a run.
 *
 * Answering that question needs numbers the load generator cannot see:
 *   - gateway: process CPU seconds, RSS, event-loop lag p50/p99, in-flight
 *     requests, GC time (from its own /metrics — prom-client defaults)
 *   - kernel: process CPU + RSS (from /proc, since FastAPI's /metrics does not
 *     carry process stats here)
 *   - Postgres: active/idle-in-transaction backends, xact commit rate, tuples
 *     read, and whether anything is waiting on a lock
 *   - Redis: instantaneous ops/sec, connected clients, blocked clients
 *   - host: load average, per-core utilisation
 *
 * Writes one JSON object per sample to results/<label>-sysmon.jsonl.
 */
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import Redis from 'ioredis';

const HERE = dirname(fileURLToPath(import.meta.url));
const RESULTS = join(HERE, '..', 'results');
mkdirSync(RESULTS, { recursive: true });

const LABEL = process.argv[2] || 'run';
const OUT = join(RESULTS, `${LABEL}-sysmon.jsonl`);
const API_METRICS = process.env.API_METRICS_URL || 'http://localhost:3001/metrics';

const client = new pg.Client({
  connectionString: process.env.DATABASE_URL
    || 'postgres://redquant_dev:redquant-dev-only-pw@127.0.0.1:5432/redquant',
});
await client.connect();
const redis = new Redis(process.env.REDIS_URL || 'redis://127.0.0.1:6379');

function pidOf(pattern) {
  try {
    const out = readFileSync('/proc/self/mounts', 'utf8'); void out;
  } catch { /* ignore */ }
  return null;
}
void pidOf;

/** Resolve the gateway / kernel / postgres / redis pids by listening socket. */
import { execSync } from 'node:child_process';
function pidOnPort(port) {
  try {
    const out = execSync(`ss -ltnpH 'sport = :${port}' 2>/dev/null`, { encoding: 'utf8' });
    const m = out.match(/pid=(\d+)/);
    return m ? Number(m[1]) : null;
  } catch { return null; }
}
const GATEWAY_PID = pidOnPort(3001);
const KERNEL_PID = pidOnPort(8100);
const WEB_PID = pidOnPort(3210);

function procStat(pid) {
  if (!pid) return null;
  try {
    const s = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const rp = s.slice(s.lastIndexOf(')') + 2).split(' ');
    const utime = Number(rp[11]);
    const stime = Number(rp[12]);
    const numThreads = Number(rp[17]);
    const rssPages = Number(rp[21]);
    return { cpuTicks: utime + stime, threads: numThreads, rssMb: Math.round((rssPages * 4096) / 1048576) };
  } catch { return null; }
}

function parseProm(text, name, labels) {
  const re = new RegExp(`^${name}(?:\\{([^}]*)\\})? ([0-9.eE+-]+)$`, 'm');
  if (!labels) {
    const m = text.match(re);
    return m ? Number(m[2]) : null;
  }
  const lines = text.split('\n').filter((l) => l.startsWith(name + '{'));
  let total = 0;
  let found = false;
  for (const l of lines) {
    if (labels.every((lb) => l.includes(lb))) {
      total += Number(l.slice(l.lastIndexOf(' ') + 1));
      found = true;
    }
  }
  return found ? total : null;
}

let prevCpu = {};
let prevHost = null;
function hostCpu() {
  const line = readFileSync('/proc/stat', 'utf8').split('\n')[0].split(/\s+/).slice(1).map(Number);
  const idle = line[3] + line[4];
  const total = line.reduce((a, b) => a + b, 0);
  const r = prevHost ? { busyPct: (1 - (idle - prevHost.idle) / (total - prevHost.total)) * 100 } : null;
  prevHost = { idle, total };
  return r ? Math.round(r.busyPct * 10) / 10 : null;
}

const HZ = 100;
function cpuPct(name, pid) {
  const st = procStat(pid);
  if (!st) return null;
  const prev = prevCpu[name];
  prevCpu[name] = { ticks: st.cpuTicks, t: Date.now() };
  if (!prev) return { rssMb: st.rssMb, threads: st.threads, cpuPct: null };
  const dt = (Date.now() - prev.t) / 1000;
  return {
    rssMb: st.rssMb,
    threads: st.threads,
    cpuPct: Math.round(((st.cpuTicks - prev.ticks) / HZ / dt) * 1000) / 10,
  };
}

let prevPg = null;
async function sample() {
  const out = { t: Date.now(), hostCpuPct: hostCpu(), load1: Number(readFileSync('/proc/loadavg', 'utf8').split(' ')[0]) };

  out.gateway = cpuPct('gw', GATEWAY_PID);
  out.kernel = cpuPct('kn', KERNEL_PID);
  out.web = cpuPct('web', WEB_PID);

  try {
    const text = await (await fetch(API_METRICS, { signal: AbortSignal.timeout(2000) })).text();
    out.gw = {
      elLagP50Ms: Math.round((parseProm(text, 'nodejs_eventloop_lag_p50_seconds') || 0) * 1e5) / 100,
      elLagP99Ms: Math.round((parseProm(text, 'nodejs_eventloop_lag_p99_seconds') || 0) * 1e5) / 100,
      elLagMaxMs: Math.round((parseProm(text, 'nodejs_eventloop_lag_max_seconds') || 0) * 1e5) / 100,
      inFlight: parseProm(text, 'http_requests_in_flight', ['']) ?? null,
      heapMb: Math.round((parseProm(text, 'nodejs_heap_size_used_bytes') || 0) / 1048576),
      activeHandles: parseProm(text, 'nodejs_active_handles_total'),
    };
  } catch (e) { out.gw = { error: String(e).slice(0, 80) }; }

  try {
    const q = await client.query(`
      SELECT
        (SELECT count(*) FROM pg_stat_activity WHERE datname='redquant' AND state='active')::int AS active,
        (SELECT count(*) FROM pg_stat_activity WHERE datname='redquant' AND state='idle in transaction')::int AS idle_in_tx,
        (SELECT count(*) FROM pg_stat_activity WHERE datname='redquant')::int AS backends,
        (SELECT count(*) FROM pg_stat_activity WHERE datname='redquant' AND wait_event_type='Lock')::int AS lock_waits,
        (SELECT setting::int FROM pg_settings WHERE name='max_connections') AS max_conn,
        (SELECT xact_commit FROM pg_stat_database WHERE datname='redquant') AS xact_commit,
        (SELECT tup_returned FROM pg_stat_database WHERE datname='redquant') AS tup_returned,
        (SELECT blks_hit FROM pg_stat_database WHERE datname='redquant') AS blks_hit,
        (SELECT blks_read FROM pg_stat_database WHERE datname='redquant') AS blks_read`);
    const r = q.rows[0];
    const now = Date.now();
    out.pg = {
      active: r.active, idleInTx: r.idle_in_tx, backends: r.backends,
      lockWaits: r.lock_waits, maxConn: r.max_conn,
    };
    if (prevPg) {
      const dt = (now - prevPg.t) / 1000;
      out.pg.commitsPerSec = Math.round((Number(r.xact_commit) - prevPg.commit) / dt);
      out.pg.tupReturnedPerSec = Math.round((Number(r.tup_returned) - prevPg.tup) / dt);
      out.pg.blksReadPerSec = Math.round((Number(r.blks_read) - prevPg.blksRead) / dt);
    }
    prevPg = { t: now, commit: Number(r.xact_commit), tup: Number(r.tup_returned), blksRead: Number(r.blks_read) };
  } catch (e) { out.pg = { error: String(e).slice(0, 80) }; }

  try {
    const info = await redis.info();
    const get = (k) => { const m = info.match(new RegExp(`^${k}:(.*)$`, 'm')); return m ? m[1].trim() : null; };
    out.redis = {
      opsPerSec: Number(get('instantaneous_ops_per_sec')),
      clients: Number(get('connected_clients')),
      blocked: Number(get('blocked_clients')),
      usedMemMb: Math.round(Number(get('used_memory')) / 1048576),
      cpuSysPct: null,
    };
  } catch (e) { out.redis = { error: String(e).slice(0, 80) }; }

  appendFileSync(OUT, JSON.stringify(out) + '\n');
}

console.log(`[sysmon] label=${LABEL} gateway pid=${GATEWAY_PID} kernel pid=${KERNEL_PID} web pid=${WEB_PID} -> ${OUT}`);
const iv = setInterval(() => { sample().catch(() => {}); }, 1000);
async function stop() { clearInterval(iv); await client.end().catch(() => {}); redis.disconnect(); process.exit(0); }
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
