#!/usr/bin/env node
// bench-run.mjs — repeatable internal A/B bench runner (mixdog).
//
// Runs a FIXED task set through the LIVE headless path (runHeadlessRole in a
// fresh child node process = identical to `mixdog <agent> <msg>` and loads the
// latest on-disk code), captures each task's session id, scores the round with
// task-bench, and freezes it to a round file. Change rules/briefs between
// rounds; the task set stays constant so rounds are comparable.
//
//   node scripts/bench-run.mjs --tasks tasks.json --round 1 --save round1.json
//   (edit rules/briefs)
//   node scripts/bench-run.mjs --tasks tasks.json --round 2 --save round2.json
//   node scripts/task-bench.mjs --vs round1.json round2.json
//
// tasks.json: [{ "id":"...", "agent":"worker", "prompt":"...", "cwd":"." }, ...]
//
// This is INTERNAL A/B only (mixdog vs its own prior round). Cross-CLI compare
// vs codex/claude (tree-total vs solo) is a separate future mode; codex/claude
// runners are left as slots.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dir = dirname(fileURLToPath(import.meta.url));
const HEADLESS = pathToFileURL(resolve(__dir, '../src/headless-role.mjs')).href;
const TASK_BENCH = resolve(__dir, 'task-bench.mjs');

function argValue(name, fallback = null) {
  const idx = process.argv.indexOf(name);
  if (idx >= 0 && idx + 1 < process.argv.length) return process.argv[idx + 1];
  const pref = `${name}=`;
  const hit = process.argv.find((a) => a.startsWith(pref));
  return hit ? hit.slice(pref.length) : fallback;
}
function hasFlag(name) { return process.argv.includes(name); }

// Model aliases so a round switches model+provider with one flag
// (--model opus|gpt|grok). Full provider/model pairs still work verbatim.
const MODEL_ALIASES = {
  opus:   { provider: 'anthropic-oauth', model: 'claude-opus-4-8' },
  sonnet: { provider: 'anthropic-oauth', model: 'claude-sonnet-5' },
  gpt:    { provider: 'openai-oauth', model: 'gpt-5.5' },
  'gpt-5.5': { provider: 'openai-oauth', model: 'gpt-5.5' },
  grok:   { provider: 'grok-oauth', model: 'grok-composer-2.5-fast' },
};
function resolveModelOpts(modelArg, providerArg) {
  const key = String(modelArg || '').trim().toLowerCase();
  if (MODEL_ALIASES[key] && !providerArg) return { ...MODEL_ALIASES[key] };
  return { provider: providerArg || null, model: modelArg || null };
}

function extractSessionId(text) {
  const s = String(text || '');
  const m = s.match(/sessionId:\s*(sess_[A-Za-z0-9_]+)/) || s.match(/\b(sess_[A-Za-z0-9_]+)/);
  return m ? m[1] : null;
}

const RUNNERS = {
  mixdog(task, opts) {
    const driver = [
      `import { runHeadlessRole } from ${JSON.stringify(HEADLESS)};`,
      `const out = [];`,
      `const code = await runHeadlessRole({`,
      `  agent: ${JSON.stringify(task.agent || 'worker')},`,
      `  message: ${JSON.stringify(task.prompt || '')},`,
      `  provider: ${JSON.stringify(opts.provider || null)},`,
      `  model: ${JSON.stringify(opts.model || null)},`,
      `  cwd: ${JSON.stringify(task.cwd ? resolve(task.cwd) : process.cwd())},`,
      `  write: (t) => out.push(t),`,
      `  writeErr: (t) => process.stderr.write(t),`,
      `});`,
      `process.stdout.write(out.join(''));`,
      `process.exit(code);`,
    ].join('\n');
    const started = Date.now();
    let raw = '';
    let ok = false;
    try {
      raw = execFileSync('node', ['--input-type=module', '-e', driver], {
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
        env: {
          ...process.env,
          ...(opts.effort ? { MIXDOG_AGENT_EFFORT: opts.effort } : {}),
          ...(opts.fast ? { MIXDOG_AGENT_FAST: '1' } : {}),
          ...(opts.env || {}),
        },
      });
      ok = true;
    } catch (e) {
      raw = String(e.stdout || '') + String(e.stderr || '');
      ok = false;
    }
    return { sessionId: extractSessionId(raw), ok, ms: Date.now() - started, raw };
  },
  codex() {
    throw new Error('runner "codex" not implemented (slot: codex exec --json). Cross-CLI compare is a separate mode.');
  },
  claude() {
    throw new Error('runner "claude" not implemented (slot: claude -p --output-format json). Cross-CLI compare is a separate mode.');
  },
};

function scoreSessions(ids) {
  if (!ids.length) return null;
  const raw = execFileSync('node', [TASK_BENCH, '--session', ids.join(','), '--group', '--json'], {
    encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
  });
  const s = raw.replace(/^\uFEFF/, '');
  const i = s.indexOf('{');
  return JSON.parse(i >= 0 ? s.slice(i) : s);
}

function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(0, ms));
}

function scoreSession(sessionId, { attempts = 5 } = {}) {
  let lastError = null;
  for (let i = 0; i < attempts; i += 1) {
    try {
      const raw = execFileSync('node', [TASK_BENCH, '--session', sessionId, '--json'], {
        encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
      });
      const s = raw.replace(/^\uFEFF/, '');
      const j = JSON.parse(s.slice(Math.max(0, s.indexOf('{'))));
      const card = Array.isArray(j.cards) ? j.cards.find((c) => c?.session === sessionId) || j.cards[0] : null;
      if (card) return { ok: true, card };
      lastError = new Error(`no scorecard returned for ${sessionId}`);
    } catch (e) {
      lastError = e;
    }
    sleepMs(250 * (i + 1));
  }
  return { ok: false, error: lastError?.message || String(lastError || 'score failed') };
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function averageCards(cards) {
  if (!cards.length) return null;
  const keys = Object.keys(cards[0]).filter((k) => cards.some((c) => typeof c[k] === 'number' && Number.isFinite(c[k])));
  const out = { n: cards.length };
  for (const k of keys) {
    const vals = cards.map((c) => num(c[k]));
    out[k] = Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 10) / 10;
  }
  return out;
}

// ---- main ----
const tasksPath = argValue('--tasks', null);
if (!tasksPath) {
  console.error('usage: --tasks <tasks.json> [--round N] [--runner mixdog] [--provider P] [--model M] [--effort E] [--fast] [--save round.json] [--json]');
  process.exit(1);
}
if (!existsSync(resolve(tasksPath))) { console.error(`tasks file not found: ${tasksPath}`); process.exit(1); }
const tasks = JSON.parse(readFileSync(resolve(tasksPath), 'utf8'));
if (!Array.isArray(tasks) || !tasks.length) { console.error('tasks.json must be a non-empty array'); process.exit(1); }

const runnerName = argValue('--runner', 'mixdog');
const runner = RUNNERS[runnerName];
if (!runner) { console.error(`unknown runner "${runnerName}" (mixdog|codex|claude)`); process.exit(1); }
const round = argValue('--round', '1');
const savePath = argValue('--save', null);
const jsonMode = hasFlag('--json');
const _mo = resolveModelOpts(argValue('--model', null), argValue('--provider', null));
// A/B knobs -> child env. --read-max-lines is a convenience for the read-policy
// bench; --env KEY=VAL (repeatable) passes any override verbatim.
const _env = {};
const _readMax = argValue('--read-max-lines', null);
if (_readMax) _env.MIXDOG_READ_MAX_LINES = String(_readMax);
for (let i = 0; i < process.argv.length; i++) {
  if (process.argv[i] === '--env' && process.argv[i + 1]) {
    const eq = process.argv[i + 1].indexOf('=');
    if (eq > 0) _env[process.argv[i + 1].slice(0, eq)] = process.argv[i + 1].slice(eq + 1);
  }
}
const opts = {
  provider: _mo.provider,
  model: _mo.model,
  effort: argValue('--effort', null),
  fast: hasFlag('--fast'),
  env: _env,
};
process.stderr.write(`[bench-run] model=${opts.model || '(agent default)'} provider=${opts.provider || '(agent default)'} effort=${opts.effort || '-'} fast=${opts.fast} env=${JSON.stringify(_env)}\n`);

const results = [];
for (const task of tasks) {
  process.stderr.write(`[bench-run] round=${round} runner=${runnerName} task=${task.id || task.agent} ...\n`);
  let r;
  try { r = runner(task, opts); }
  catch (e) { console.error(`[bench-run] runner error: ${e.message}`); process.exit(1); }
  process.stderr.write(`[bench-run]   -> ${r.ok ? 'ok' : 'FAIL'} ${Math.round(r.ms / 1000)}s session=${r.sessionId || '(none)'}\n`);
  const result = { id: task.id || null, agent: task.agent || null, ok: r.ok, ms: r.ms, sessionId: r.sessionId };
  if (r.sessionId) {
    const scored = scoreSession(r.sessionId);
    if (scored.ok) {
      result.card = scored.card;
      process.stderr.write(`[bench-run]   -> scored ${r.sessionId.slice(0, 22)} turns=${scored.card.turns} tools=${scored.card.tool_calls}\n`);
    } else {
      result.scoreError = scored.error;
      process.stderr.write(`[bench-run]   -> SCORE FAIL ${r.sessionId.slice(0, 22)} ${scored.error}\n`);
    }
  }
  results.push(result);
}

const sessionIds = results.map((r) => r.sessionId).filter(Boolean);
const scoredCards = results.map((r) => r.card).filter(Boolean);
const scoreErrors = results
  .filter((r) => !r.card)
  .map((r) => ({ id: r.id, sessionId: r.sessionId || null, error: r.sessionId ? (r.scoreError || 'missing scorecard') : 'missing sessionId' }));
const score = scoredCards.length ? { cards: scoredCards, group: averageCards(scoredCards.map(({ session, ...c }) => c)) } : null;
const completed = results.filter((r) => r.ok).length;
const taskErrors = results
  .filter((r) => !r.ok)
  .map((r) => ({ id: r.id, sessionId: r.sessionId || null, error: 'task failed' }));
const roundResult = {
  round, runner: runnerName, opts,
  tasks: results.length, completed,
  completion_rate: results.length ? Math.round((completed / results.length) * 100) : 0,
  sessions: sessionIds, results,
  task_complete: results.length > 0 && completed === results.length,
  task_errors: taskErrors,
  score_complete: results.length > 0 && taskErrors.length === 0 && scoreErrors.length === 0 && (score?.cards?.length || 0) === results.length,
  score_errors: scoreErrors,
  group: score?.group || null,
  cards: score?.cards || null,
};

if (roundResult.task_complete === false) {
  console.error(`[bench-run] incomplete tasks: completed=${completed}/${results.length}`);
  for (const e of taskErrors) console.error(`[bench-run] task error ${e.id || '-'} ${e.sessionId || '(no session)'}`);
}
if (roundResult.score_complete === false) {
  console.error(`[bench-run] incomplete scoring: scored=${roundResult.cards?.length || 0}/${results.length}`);
  for (const e of scoreErrors) console.error(`[bench-run] score error ${e.id || '-'} ${e.sessionId || '(no session)'}: ${e.error}`);
}
if (savePath) {
  if (roundResult.task_complete === false || roundResult.score_complete === false) {
    console.error(`[bench-run] not saving incomplete round -> ${resolve(savePath)}`);
  } else {
  writeFileSync(resolve(savePath), JSON.stringify(roundResult, null, 2));
  console.error(`[bench-run] saved round ${round} -> ${resolve(savePath)}`);
  }
}
if (jsonMode) {
  console.log(JSON.stringify(roundResult, null, 2));
} else {
  console.log(`round=${round} runner=${runnerName} tasks=${results.length} completed=${completed} (${roundResult.completion_rate}%)`);
  for (const r of results) console.log(`- ${r.id || r.agent}: ${r.ok ? 'ok' : 'FAIL'} ${Math.round(r.ms / 1000)}s ${r.sessionId ? r.sessionId.slice(0, 22) : '(no session)'}`);
  if (roundResult.group) {
    const g = roundResult.group;
    console.log(`group: wall=${Math.round((g.wall_ms || 0) / 1000)}s turns=${g.turns} tools=${g.tool_calls} tpt=${g.tools_per_turn} tool_ms=${Math.round((g.total_tool_ms || 0) / 1000)}s cache=${Math.round((g.cache_ratio || 0) * 100)}% antipatterns=${g.antipatterns}`);
  }
}
if (roundResult.task_complete === false || roundResult.score_complete === false) process.exit(1);
