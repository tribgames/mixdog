// Tool-layer burst stress: hammers the in-process tool execution surface with
// concurrent multi-session waves and checks that results stay correct and
// bounded under load (no unhandled rejections, no resource-pressure failures,
// patch/read integrity preserved, cancellation clean). One-shot script:
// `node scripts/tool-stress.mjs`. Exit 0 = stable, 1 = instability found.
import '../src/runtime/shared/uv-threadpool-boot.mjs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { executeBuiltinTool } from '../src/runtime/agent/orchestrator/tools/builtin.mjs';
import { executeCodeGraphTool } from '../src/runtime/agent/orchestrator/tools/code-graph.mjs';
import { executePatchTool } from '../src/runtime/agent/orchestrator/tools/patch.mjs';

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const SESSIONS = 8;
const WAVES = 5;
const stats = new Map(); // tool -> {n, errs:[], lat:[]}
const failures = [];

function record(tool, ms, result, expectRe) {
  let s = stats.get(tool);
  if (!s) { s = { n: 0, errs: [], lat: [] }; stats.set(tool, s); }
  s.n += 1; s.lat.push(ms);
  const text = String(result ?? '');
  if (/^Error:|resource pressure|ERESOURCEPRESSURE|EAGAIN/i.test(text)) s.errs.push(text.slice(0, 160));
  else if (expectRe && !expectRe.test(text)) s.errs.push(`unexpected output: ${text.slice(0, 120)}`);
}

async function timed(tool, expectRe, fn) {
  const t0 = Date.now();
  try {
    const out = await fn();
    record(tool, Date.now() - t0, out, expectRe);
    return out;
  } catch (err) {
    record(tool, Date.now() - t0, `Error: thrown ${err?.message || err}`);
    return null;
  }
}

function pct(list, p) {
  if (!list.length) return 0;
  const sorted = [...list].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

const tmp = mkdtempSync(join(tmpdir(), 'mixdog-tool-stress-'));
const t0 = Date.now();
try {
  // ── Phase A+C: concurrent multi-session waves (search/read/graph/shell +
  // per-session patch integrity riding the same load) ──────────────────────
  for (let wave = 0; wave < WAVES; wave++) {
    const calls = [];
    for (let s = 0; s < SESSIONS; s++) {
      const opts = { sessionId: `stress-s${s}` };
      const marker = `stress_w${wave}_s${s}`;
      calls.push(
        timed('grep', /path-string|paths only|grep|\(no matches\)|Fuzzy/i, () => executeBuiltinTool('grep', {
          pattern: ['Fuzzy filename', 'paths only'], path: 'src/runtime/agent/orchestrator/tools/builtin', glob: '*.mjs', limit: 20, context: 0,
        }, root, opts)),
        timed('glob', /tool-defs\.mjs|\.mjs/, () => executeBuiltinTool('glob', {
          pattern: '**/*.mjs', path: 'src/session-runtime', limit: 40,
        }, root, opts)),
        timed('find', /tool-defs|no fuzzy match/, () => executeBuiltinTool('find', {
          query: 'tool-defs', limit: 8,
        }, root, opts)),
        timed('list', /01-tool\.md|file/, () => executeBuiltinTool('list', {
          path: 'src/rules/shared',
        }, root, opts)),
        timed('read', /Tool Use|read/, () => executeBuiltinTool('read', {
          path: [['src/rules/shared/01-tool.md', 0, 10], ['package.json', 0, 5]],
        }, root, opts)),
        timed('code_graph', /symbol|binding|files|edges/i, () => executeCodeGraphTool('code_graph', {
          mode: 'symbols', files: 'scripts/smoke.mjs',
        }, root)),
        timed('shell', /55350/, () => executeBuiltinTool('shell', {
          command: 'node -e "console.log(123*450)"', timeout: 60_000,
        }, root, opts)),
        (async () => {
          const patch = [
            '*** Begin Patch',
            `*** Add File: ${marker}.txt`,
            `+payload ${marker}`,
            '*** End Patch',
          ].join('\n');
          await timed('apply_patch', /applied|OK/i, () => executePatchTool('apply_patch', { patch, base_path: tmp }, tmp, opts));
          const back = await timed('read-verify', new RegExp(`payload ${marker}`), () => executeBuiltinTool('read', { path: `${marker}.txt` }, tmp, opts));
          if (!String(back || '').includes(`payload ${marker}`)) failures.push(`patch integrity lost for ${marker}`);
        })(),
      );
    }
    await Promise.all(calls);
  }

  // ── Phase B: oversized inputs stay budget-bounded ─────────────────────────
  await Promise.all([
    timed('grep-broad', /Showing|import|export/, () => executeBuiltinTool('grep', {
      pattern: 'import', path: 'src', limit: 300, mode: 'files',
    }, root, { sessionId: 'stress-big' })),
    timed('glob-broad', /\.mjs|entries/, () => executeBuiltinTool('glob', {
      pattern: '**/*', path: 'src/runtime/agent/orchestrator/tools', limit: 0,
    }, root, { sessionId: 'stress-big' })),
    timed('read-big', /./, () => executeBuiltinTool('read', {
      path: 'src/tui/dist/index.mjs', limit: 2000,
    }, root, { sessionId: 'stress-big' })),
  ]);
  for (const [tool, s] of stats) {
    if (tool.endsWith('-broad') || tool === 'read-big') {
      const worst = Math.max(...s.lat);
      if (worst > 30_000) failures.push(`${tool} exceeded 30s budget: ${worst}ms`);
    }
  }

  // ── Phase D: cancellation under load ─────────────────────────────────────
  const bg = await timed('shell-async', /task_id/, () => executeBuiltinTool('shell', {
    command: 'node -e "setTimeout(()=>{}, 30000)"', mode: 'async', timeout: 60_000,
  }, root, { sessionId: 'stress-cancel' }));
  const bgId = (/task_id:\s*(\S+)/.exec(String(bg)) || [])[1];
  if (!bgId) failures.push('async shell did not return task_id');
  else {
    await timed('task-cancel', /cancelled/, () => executeBuiltinTool('task', { action: 'cancel', task_id: bgId }, root, { sessionId: 'stress-cancel' }));
    const st = await timed('task-status', /cancelled|failed/, () => executeBuiltinTool('task', { action: 'status', task_id: bgId }, root, { sessionId: 'stress-cancel' }));
    if (!/cancelled/.test(String(st))) failures.push(`cancelled task not reported cancelled: ${String(st).slice(0, 120)}`);
  }
} finally {
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best-effort */ }
}

// ── Report ──────────────────────────────────────────────────────────────────
let errTotal = 0;
for (const [tool, s] of [...stats.entries()].sort()) {
  errTotal += s.errs.length;
  console.log(
    `${tool.padEnd(14)} n=${String(s.n).padStart(3)} errs=${s.errs.length}`
    + ` p50=${pct(s.lat, 50)}ms p95=${pct(s.lat, 95)}ms max=${Math.max(...s.lat)}ms`,
  );
  for (const e of s.errs.slice(0, 3)) console.log(`  ! ${e}`);
}
for (const f of failures) console.log(`FAIL ${f}`);
const calls = [...stats.values()].reduce((a, s) => a + s.n, 0);
console.log(`tool stress ${failures.length || errTotal ? 'FAILED' : 'passed'} calls=${calls} errors=${errTotal} failures=${failures.length} elapsed=${Math.round((Date.now() - t0) / 1000)}s`);
process.exit(failures.length || errTotal ? 1 : 0);
