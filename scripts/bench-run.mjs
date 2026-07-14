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
import { execFile, execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const __dir = dirname(fileURLToPath(import.meta.url));
const HEADLESS = pathToFileURL(resolve(__dir, '../src/headless-role.mjs')).href;
const WORKFLOW_MOD = pathToFileURL(resolve(__dir, '../src/session-runtime/workflow.mjs')).href;
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
  // Full Lead session (workflow routing + agent tool fan-out). This is the
  // same path the REPL drives: createMixdogSessionRuntime().ask(). Use it to
  // measure the delegation/cost-routing design (explorer/worker on cheap
  // models, lead/reviewer on frontier) instead of a single-role headless run.
  async lead(task, opts) {
    const RUNTIME_URL = pathToFileURL(resolve(__dir, '../src/mixdog-session-runtime.mjs')).href;
    const driver = [
      `import { createMixdogSessionRuntime } from ${JSON.stringify(RUNTIME_URL)};`,
      `import { normalizeWorkflowId } from ${JSON.stringify(WORKFLOW_MOD)};`,
      `process.chdir(${JSON.stringify(task.cwd ? resolve(task.cwd) : process.cwd())});`,
      `const rt = await createMixdogSessionRuntime({`,
      `  provider: ${JSON.stringify(opts.provider || null)} || undefined,`,
      `  model: ${JSON.stringify(opts.model || null)} || undefined,`,
      `});`,
      `if (${JSON.stringify(opts.workflow || null)}) {`,
      `  await rt.setWorkflow(normalizeWorkflowId(${JSON.stringify(opts.workflow || null)}));`,
      `}`,
      `let text = '';`,
      `// Mirror the TUI auto-resume EXACTLY (engine/agent-job-feed.mjs):`,
      `// runtime notifications enqueue the model-visible completion into the`,
      `// session's pending queue; the TUI then kicks an EMPTY pending-resume`,
      `// ask (no injected user text) via queueMicrotask — the pre-send drain`,
      `// pulls the pending messages. No polling, no synthetic 'continue', no`,
      `// verdict heuristic: resume immediately per kick, finish when no kick`,
      `// arrived during the last turn.`,
      `let busy = false;`,
      `let kickDeferred = false;`,
      `let wake = null;`,
      `rt.onNotification(() => {`,
      `  // Defer like scheduleExecutionPendingResumeKick: the model-visible`,
      `  // body is enqueued after onNotification returns.`,
      `  queueMicrotask(() => {`,
      `    if (busy) { kickDeferred = true; return; }`,
      `    kickDeferred = true;`,
      `    if (wake) wake();`,
      `  });`,
      `  return false;`,
      `});`,
      `const askOnce = async (msg) => {`,
      `  busy = true;`,
      `  try {`,
      `    let t = '';`,
      `    const { result } = await rt.ask(msg, { onTextDelta: (c) => { t += c; } });`,
      `    return String(result?.text ?? t ?? '');`,
      `  } finally { busy = false; }`,
      `};`,
      `text = await askOnce(${JSON.stringify(task.prompt || '')});`,
      `const deadline = Date.now() + 30 * 60_000;`,
      `// Session is "settled" only when no delegated agent task is still`,
      `// running/pending — the live TUI stays open while agents run, so the`,
      `// bench must too. Idle grace only applies once the agent board is clear.`,
      `const agentsBusy = () => {`,
      `  try {`,
      `    const st = rt.agentStatus?.() || {};`,
      `    const jobs = Array.isArray(st.agentJobs) ? st.agentJobs : [];`,
      `    return jobs.some((j) => /running|pending|spawn|queued/i.test(String(j?.status || j?.state || '')));`,
      `  } catch { return false; }`,
      `};`,
      `while (Date.now() < deadline) {`,
      `  if (!kickDeferred) {`,
      `    // Wait for the next kick. While agent tasks are still running the`,
      `    // wait is unbounded (like a live TUI left open); once the board is`,
      `    // clear a short grace catches stragglers, then the session settles.`,
      `    for (;;) {`,
      `      const kicked = await new Promise((r) => {`,
      `        wake = () => r(true);`,
      `        setTimeout(() => r(false), 10_000);`,
      `      });`,
      `      wake = null;`,
      `      if (kicked || kickDeferred) break;`,
      `      if (!agentsBusy()) break;`,
      `      if (Date.now() >= deadline) break;`,
      `    }`,
      `    if (!kickDeferred && !agentsBusy()) break;`,
      `  }`,
      `  kickDeferred = false;`,
      `  const t = await askOnce('');`,
      `  if (String(t || '').trim()) text = t;`,
      `}`,
      `const sid = rt.sessionId || rt.session?.id || '';`,
      `process.stdout.write('sessionId: ' + sid + '\\n');`,
      `process.stdout.write(text);`,
      `await rt.close('bench-exit');`,
      `process.exit(0);`,
    ].join('\n');
    const started = Date.now();
    const { raw, ok } = await new Promise((resolveRun) => {
      execFile('node', ['--input-type=module', '-e', driver], {
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
        env: {
          ...process.env,
          ...(opts.env || {}),
        },
      }, (err, stdout, stderrOut) => {
        if (err) resolveRun({ raw: String(stdout || '') + String(stderrOut || ''), ok: false });
        else resolveRun({ raw: String(stdout || ''), ok: true });
      });
    });
    return { sessionId: extractSessionId(raw), ok, ms: Date.now() - started, raw };
  },
  async mixdog(task, opts) {
    if (!opts.provider || !opts.model) {
      throw new Error(
        'mixdog headless runner requires explicit --provider and --model (or a model alias)',
      );
    }
    const driver = [
      `import { runHeadlessRole } from ${JSON.stringify(HEADLESS)};`,
      `const out = [];`,
      `const code = await runHeadlessRole({`,
      `  agent: ${JSON.stringify(task.agent || 'worker')},`,
      `  message: ${JSON.stringify(task.prompt || '')},`,
      `  provider: ${JSON.stringify(opts.provider || null)},`,
      `  model: ${JSON.stringify(opts.model || null)},`,
      `  effort: ${JSON.stringify(opts.effort || null)},`,
      `  fast: ${JSON.stringify(opts.fast === true)},`,
      `  cwd: ${JSON.stringify(task.cwd ? resolve(task.cwd) : process.cwd())},`,
      `  write: (t) => out.push(t),`,
      `  writeErr: (t) => process.stderr.write(t),`,
      `});`,
      `process.stdout.write(out.join(''));`,
      `process.exit(code);`,
    ].join('\n');
    const started = Date.now();
    const { raw, ok } = await new Promise((resolveRun) => {
      execFile('node', ['--input-type=module', '-e', driver], {
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
        env: {
          ...process.env,
          ...(opts.env || {}),
        },
      }, (err, stdout, stderrOut) => {
        if (err) resolveRun({ raw: String(stdout || '') + String(stderrOut || ''), ok: false });
        else resolveRun({ raw: String(stdout || ''), ok: true });
      });
    });
    return { sessionId: extractSessionId(raw), ok, ms: Date.now() - started, raw };
  },
  // Cross-CLI runner: codex exec --json (JSONL events). Prompt goes via stdin
  // ("-") so no shell-quoting issues on Windows (.cmd shim needs shell:true).
  // Sandbox is read-only: review tasks must not mutate the repo. Usage comes
  // from turn.completed events; the final agent_message is kept for judging.
  async codex(task, opts) {
    const args = ['exec', '--json', '--skip-git-repo-check', '-s', 'read-only',
      '-C', task.cwd ? resolve(task.cwd) : process.cwd()];
    if (opts.model) args.push('-m', opts.model);
    if (opts.effort) args.push('-c', `model_reasoning_effort="${opts.effort}"`);
    if (opts.fast) args.push('-c', 'service_tier="fast"');
    args.push('-');
    const started = Date.now();
    const { raw, ok } = await new Promise((resolveRun) => {
      const child = spawn('codex', args, { shell: true, env: { ...process.env, ...(opts.env || {}) } });
      let out = '';
      let errOut = '';
      child.stdout.on('data', (d) => { out += d; });
      child.stderr.on('data', (d) => { errOut += d; });
      child.on('error', (e) => resolveRun({ raw: `${out}\n${errOut}\n${e.message}`, ok: false }));
      child.on('close', (code) => resolveRun({ raw: code === 0 ? out : `${out}\n${errOut}`, ok: code === 0 }));
      child.stdin.write(String(task.prompt || ''));
      child.stdin.end();
    });
    const ms = Date.now() - started;
    // Parse JSONL: thread id, summed usage, final agent message.
    let threadId = null;
    const usage = { uncached_in: 0, cached_in: 0, out_tokens: 0 };
    let finalMessage = '';
    for (const line of raw.split(/\r?\n/)) {
      if (!line.trim().startsWith('{')) continue;
      let ev = null;
      try { ev = JSON.parse(line); } catch { continue; }
      if (ev?.thread_id && !threadId) threadId = String(ev.thread_id);
      const u = ev?.usage || ev?.turn?.usage || null;
      if (u) {
        usage.uncached_in += num(u.input_tokens) - num(u.cached_input_tokens);
        usage.cached_in += num(u.cached_input_tokens);
        usage.out_tokens += num(u.output_tokens);
      }
      const item = ev?.item;
      if (item && (item.type === 'agent_message' || item.item_type === 'agent_message') && item.text) {
        finalMessage = String(item.text);
      }
    }
    const totalIn = usage.uncached_in + usage.cached_in;
    const card = {
      session: threadId || `codex-${started}`,
      wall_ms: ms,
      uncached_in: usage.uncached_in,
      cached_in: usage.cached_in,
      out_tokens: usage.out_tokens,
      cache_ratio: totalIn > 0 ? Math.round((usage.cached_in / totalIn) * 1000) / 1000 : 0,
      completed: ok ? 1 : 0,
      usd_cost: usdCost(opts.model, usage.uncached_in, usage.cached_in, usage.out_tokens),
    };
    return { sessionId: card.session, ok, ms, raw, card, finalMessage };
  },
  claude() {
    throw new Error('runner "claude" not implemented (slot: claude -p --output-format json). Cross-CLI compare is a separate mode.');
  },
};

function scoreSessions(ids) {
  if (!ids.length) return null;
  const raw = execFileSync('node', [TASK_BENCH, '--session', ids.join(','), '--group', '--json'], {
    encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, ...(opts?.env || {}) },
  });
  const s = raw.replace(/^\uFEFF/, '');
  const i = s.indexOf('{');
  return JSON.parse(i >= 0 ? s.slice(i) : s);
}

function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(0, ms));
}

function scoreSession(sessionId, { attempts = 5, env = null } = {}) {
  let lastError = null;
  for (let i = 0; i < attempts; i += 1) {
    try {
      const raw = execFileSync('node', [TASK_BENCH, '--session', sessionId, '--json'], {
        encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
        env: { ...process.env, ...(env || {}) },
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

// USD list pricing per 1M tokens (input / cached input / output), 2026-07.
// Cross-harness cost comparison needs a real currency: OAuth lanes bill
// quota, not dollars, but token counts priced at API list rates are the
// only harness-neutral metric. Unknown models fall back to gpt-5.5 rates.
const USD_PER_1M = {
  'gpt-5.5': { in: 5.00, cachedIn: 0.50, out: 30.00 },
  'gpt-5.6-sol': { in: 5.00, cachedIn: 0.50, out: 30.00 },
  'gpt-5.6-terra': { in: 2.50, cachedIn: 0.25, out: 15.00 },
  'gpt-5.6-luna': { in: 1.00, cachedIn: 0.10, out: 6.00 },
  'claude-sonnet-5': { in: 2.00, cachedIn: 0.20, out: 10.00 },
  'claude-fable-5': { in: 5.00, cachedIn: 0.50, out: 25.00 },
};
function usdCost(model, uncachedIn, cachedIn, outTokens) {
  const key = String(model || '').toLowerCase();
  const p = USD_PER_1M[key]
    || USD_PER_1M[Object.keys(USD_PER_1M).find((k) => key.includes(k))]
    || USD_PER_1M['gpt-5.5'];
  return Math.round(((num(uncachedIn) * p.in + num(cachedIn) * p.cachedIn + num(outTokens) * p.out) / 1e6) * 10000) / 10000;
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
let ownedBenchTraceDir = null;
function cleanupOwnedBenchTrace() {
  if (!ownedBenchTraceDir) return;
  const dir = ownedBenchTraceDir;
  ownedBenchTraceDir = null;
  rmSync(dir, { recursive: true, force: true });
}
const _readMax = argValue('--read-max-lines', null);
if (_readMax) _env.MIXDOG_READ_MAX_LINES = String(_readMax);
for (let i = 0; i < process.argv.length; i++) {
  if (process.argv[i] === '--env' && process.argv[i + 1]) {
    const eq = process.argv[i + 1].indexOf('=');
    if (eq > 0) _env[process.argv[i + 1].slice(0, eq)] = process.argv[i + 1].slice(eq + 1);
  }
}
if (runnerName === 'mixdog' && !_env.MIXDOG_AGENT_TRACE_PATH) {
  if (process.env.MIXDOG_AGENT_TRACE_PATH) {
    _env.MIXDOG_AGENT_TRACE_PATH = process.env.MIXDOG_AGENT_TRACE_PATH;
  } else {
    ownedBenchTraceDir = mkdtempSync(join(tmpdir(), 'mixdog-bench-trace-'));
    _env.MIXDOG_AGENT_TRACE_PATH = join(ownedBenchTraceDir, 'agent-trace.jsonl');
    process.once('exit', cleanupOwnedBenchTrace);
  }
}
const opts = {
  provider: _mo.provider,
  model: _mo.model,
  effort: argValue('--effort', null),
  fast: hasFlag('--fast'),
  workflow: argValue('--workflow', null),
  env: _env,
};
process.stderr.write(`[bench-run] model=${opts.model || '(agent default)'} provider=${opts.provider || '(agent default)'} effort=${opts.effort || '-'} fast=${opts.fast} workflow=${opts.workflow || '-'} env=${JSON.stringify(_env)}\n`);

// --parallel N: run up to N tasks concurrently (default: all). Scoring stays
// sequential after runs so task-bench reads a settled trace.
const parallel = Math.max(1, Number.parseInt(argValue('--parallel', String(tasks.length)), 10) || tasks.length);
// --repeat N: run the whole task set N times (repeat r appended to task id as
// "id#r") so group averages settle over more samples.
const repeat = Math.max(1, Number.parseInt(argValue('--repeat', '1'), 10) || 1);
// --stagger MS: delay each parallel lane's start by laneIndex*MS so session
// first-calls don't race the server prompt-cache write window (A/B for
// parallel fan-out cache misses).
const staggerMs = Math.max(0, Number.parseInt(argValue('--stagger', '0'), 10) || 0);
process.stderr.write(`[bench-run] parallel=${parallel} repeat=${repeat} stagger=${staggerMs}ms\n`);
const runList = [];
for (let r = 1; r <= repeat; r += 1) {
  for (const task of tasks) {
    runList.push(repeat > 1 ? { ...task, id: `${task.id || task.agent}#${r}` } : task);
  }
}

async function runTask(task) {
  process.stderr.write(`[bench-run] round=${round} runner=${runnerName} task=${task.id || task.agent} ...\n`);
  let r;
  try { r = await runner(task, opts); }
  catch (e) {
    console.error(`[bench-run] runner error (${task.id || task.agent}): ${e.message}`);
    return { id: task.id || null, agent: task.agent || null, ok: false, ms: 0, sessionId: null };
  }
  process.stderr.write(`[bench-run]   -> ${task.id || task.agent}: ${r.ok ? 'ok' : 'FAIL'} ${Math.round(r.ms / 1000)}s session=${r.sessionId || '(none)'}\n`);
  return {
    id: task.id || null, agent: task.agent || null, ok: r.ok, ms: r.ms, sessionId: r.sessionId,
    // External runners (codex/claude) pre-build their scorecard; mixdog scores
    // from its own trace below. Output text is kept for quality judging.
    ...(r.card ? { card: r.card } : {}),
    output: String(r.finalMessage || r.raw || '').slice(-8000),
  };
}

const results = new Array(runList.length);
{
  let next = 0;
  async function drain(lane) {
    if (staggerMs > 0 && lane > 0) await new Promise((res) => setTimeout(res, lane * staggerMs));
    for (;;) {
      const i = next++;
      if (i >= runList.length) return;
      results[i] = await runTask(runList[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(parallel, runList.length) }, (_, lane) => drain(lane)));
}

for (const result of results) {
  if (!result.sessionId) continue;
  if (result.card) continue; // external runner already carries its card
  const scored = scoreSession(result.sessionId, { env: opts.env });
  if (scored.ok) {
    result.card = scored.card;
    // task-bench cards expose uncached/cached/output token fields; price at
    // the session's own model when present, else the round's --model.
    const c = scored.card;
    c.usd_cost = usdCost(c.model || opts.model, c.uncached_tokens, c.cached_tokens, c.output_tokens);
    process.stderr.write(`[bench-run]   -> scored ${result.sessionId.slice(0, 22)} turns=${scored.card.turns} tools=${scored.card.tool_calls}\n`);
  } else {
    result.scoreError = scored.error;
    process.stderr.write(`[bench-run]   -> SCORE FAIL ${result.sessionId.slice(0, 22)} ${scored.error}\n`);
  }
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
const incomplete = roundResult.task_complete === false || roundResult.score_complete === false;
cleanupOwnedBenchTrace();
if (incomplete) process.exit(1);
