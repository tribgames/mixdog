// How much trial budget is burned AFTER the agent loop has already finished.
// Work time = first→last trace event; idle = agentSeconds minus that.
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateRunReport } from './run-report.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const TB = resolve(here, '..');
const dir = process.argv[2] || join(TB, 'jobs-full-sol-xhigh-20260823-171008');

const rep = generateRunReport({ jobsDir: dir, historyRoot: TB, status: true });
const runDir = readdirSync(dir).find((d) => d.startsWith('2026-'));

const spans = new Map();
const servers = new Map();
for (const trial of readdirSync(join(dir, runDir))) {
  const p = join(dir, runDir, trial, 'agent', 'agent-trace.jsonl');
  if (!existsSync(p)) continue;
  const task = trial.slice(0, trial.lastIndexOf('__')) || trial;
  const ts = [];
  let bg = 0;
  for (const line of readFileSync(p, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    if (o.ts) ts.push(o.ts);
    if (o.kind === 'tool' && o.tool_name === 'shell'
      && (o.tool_ms || 0) >= 9800
      && !(o.tool_args || {}).timeout_ms) bg += 1;
  }
  if (ts.length) spans.set(task, (Math.max(...ts) - Math.min(...ts)) / 1000);
  servers.set(task, bg);
}

let total = 0;
let idle = 0;
const rows = [];
for (const t of rep.tasks.filter((x) => x.settled)) {
  const a = t.agentSeconds || 0;
  total += a;
  const s = spans.get(t.task);
  if (s == null) continue;
  const w = a - s;
  if (w > 60) { idle += w; rows.push([t.task, a, s, w, t.passed, servers.get(t.task) || 0]); }
}
rows.sort((x, y) => y[3] - x[3]);
console.log(`completed agent seconds: ${Math.round(total)}`);
console.log(`idle-at-exit waste: ${Math.round(idle)} (${(idle / (total || 1) * 100).toFixed(1)}%)`);
console.log('');
console.log('task                              agent_s  work_s  idle_s  bg_srv pass');
for (const [t, a, s, w, p, b] of rows) {
  console.log(`${t.padEnd(32)} ${String(Math.round(a)).padStart(8)} ${String(Math.round(s)).padStart(7)} ${String(Math.round(w)).padStart(7)} ${String(b).padStart(7)} ${p}`);
}
