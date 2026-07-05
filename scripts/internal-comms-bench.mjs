#!/usr/bin/env node
// internal-comms-bench.mjs — live A/B token measurement for internal-comms rules.
//
// Variant A (verbose): prior committed blobs via `git show HEAD:src/<rule>`.
// Variant B (optimized): current on-disk src/ copied into a temp PLUGIN_ROOT.
// Only the listed rule files differ between variants; everything else matches.
//
//   node scripts/internal-comms-bench.mjs
//   node scripts/internal-comms-bench.mjs --run [--model grok] [--provider P] [--json]
import { execFileSync } from 'node:child_process';
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dir = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dir, '..');
const PLUGIN_ROOT = join(REPO_ROOT, 'src');
const HEADLESS = pathToFileURL(resolve(__dir, '../src/headless-role.mjs')).href;

const RULE_FILES = [
  'rules/agent/00-core.md',
  'rules/agent/00-common.md',
  'agents/worker/AGENT.md',
  'agents/heavy-worker/AGENT.md',
  'agents/reviewer/AGENT.md',
  'agents/debugger/AGENT.md',
  'workflows/default/WORKFLOW.md',
  'rules/lead/lead-tool.md',
  'rules/lead/lead-brief.md',
];

const DEFAULT_WORKER_PROMPT =
  'In math.js add an exported function add(a, b) that returns a + b. Keep the existing mul export unchanged. Use apply_patch only. Stop when the function exists; hand off with outcome and file:line.';

// Lead-mode task: FORCES delegation so the real internal-comms flow runs
// (Lead writes a brief -> worker returns a handoff -> reviewer verifies).
// Identical across variants A/B; only the on-disk rule files differ.
const DEFAULT_LEAD_PROMPT = [
  'You are the Lead in an automation benchmark. A file named math.js already exists in your working directory.',
  'Do NOT edit any file yourself and do NOT call apply_patch yourself. You MUST delegate every implementation step.',
  'Step 1: call the agent tool with agent "worker" and give it a brief to add an exported function add(a, b) that returns a + b to math.js, keeping the existing mul export unchanged, using apply_patch only.',
  'Step 2: after the worker hands off, call the agent tool with agent "reviewer" and give it a brief to verify that math.js exports both add and mul.',
  'Step 3: stop and reply with a one-line outcome plus math.js:line. Do exactly these three steps and nothing else.',
].join(' ');

const MODEL_ALIASES = {
  opus: { provider: 'anthropic-oauth', model: 'claude-opus-4-8' },
  sonnet: { provider: 'anthropic-oauth', model: 'claude-sonnet-5' },
  gpt: { provider: 'openai-oauth', model: 'gpt-5.5' },
  'gpt-5.5': { provider: 'openai-oauth', model: 'gpt-5.5' },
  grok: { provider: 'grok-oauth', model: 'grok-composer-2.5-fast' },
};

const AUTH_ARTIFACT_BY_PROVIDER = {
  'grok-oauth': ['grok-oauth.json', 'grok-oauth-models.json'],
  'anthropic-oauth': ['anthropic-oauth-credentials.json', 'anthropic-oauth-models.json'],
  'openai-oauth': ['openai-oauth.json', 'openai-oauth-models.json'],
};

const INITIAL_MATH_JS = `export function mul(a, b) {
  return a * b;
}
`;

function argValue(name, fallback = null) {
  const idx = process.argv.indexOf(name);
  if (idx >= 0 && idx + 1 < process.argv.length) return process.argv[idx + 1];
  const pref = `${name}=`;
  const hit = process.argv.find((a) => a.startsWith(pref));
  return hit ? hit.slice(pref.length) : fallback;
}
function hasFlag(name) { return process.argv.includes(name); }

function resolveModelOpts(modelArg, providerArg) {
  const key = String(modelArg || '').trim().toLowerCase();
  if (MODEL_ALIASES[key] && !providerArg) return { ...MODEL_ALIASES[key] };
  return { provider: providerArg || null, model: modelArg || null };
}

function defaultUserDataDir() {
  return process.env.MIXDOG_DATA_DIR || join(process.env.MIXDOG_HOME || join(homedir(), '.mixdog'), 'data');
}

function readUnifiedConfig(dataDir) {
  try {
    const unified = JSON.parse(readFileSync(join(dataDir, 'mixdog-config.json'), 'utf8'));
    return unified && typeof unified === 'object' ? unified : {};
  } catch { return {}; }
}

function gitPathForRule(relFromSrc) {
  return `src/${String(relFromSrc).replace(/\\/g, '/')}`;
}

function readPriorRuleBlob(relFromSrc) {
  const gitPath = gitPathForRule(relFromSrc);
  try {
    return execFileSync('git', ['show', `HEAD:${gitPath}`], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      maxBuffer: 8 * 1024 * 1024,
    });
  } catch {
    return null;
  }
}

function readCurrentRule(relFromSrc) {
  return readFileSync(join(PLUGIN_ROOT, relFromSrc), 'utf8');
}

function ruleVariantBytes() {
  const rows = [];
  for (const rel of RULE_FILES) {
    const prior = readPriorRuleBlob(rel);
    const current = readCurrentRule(rel);
    const aText = prior != null ? prior : current;
    rows.push({
      file: rel,
      a_chars: aText.length,
      b_chars: current.length,
      prior_from_git: prior != null,
    });
  }
  return rows;
}

function authArtifactNamesForSandbox(realDataDir, provider) {
  const names = new Set();
  for (const file of AUTH_ARTIFACT_BY_PROVIDER[provider] || []) names.add(file);
  try {
    for (const entry of readdirSync(realDataDir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      if (/oauth/i.test(entry.name) || /credentials/i.test(entry.name)) names.add(entry.name);
    }
  } catch { /* missing real data dir */ }
  return [...names];
}

function copyAuthArtifacts(realDataDir, sandboxDataDir, provider) {
  const copied = [];
  const skipped = [];
  for (const name of authArtifactNamesForSandbox(realDataDir, provider)) {
    const src = join(realDataDir, name);
    const dest = join(sandboxDataDir, name);
    if (!existsSync(src)) {
      skipped.push(name);
      continue;
    }
    try {
      copyFileSync(src, dest);
      copied.push(name);
    } catch {
      skipped.push(name);
    }
  }
  return { copied, skipped };
}

function materializePluginRoot(variant, sandboxRoot) {
  const pluginRoot = join(sandboxRoot, `plugin-${variant}`);
  cpSync(PLUGIN_ROOT, pluginRoot, { recursive: true });
  if (variant === 'A') {
    for (const rel of RULE_FILES) {
      const prior = readPriorRuleBlob(rel);
      if (prior != null) writeFileSync(join(pluginRoot, rel), prior, 'utf8');
    }
  }
  return pluginRoot;
}

function prepareDataDir(sandboxRoot, variant, realDataDir, userUnified, provider) {
  const dataDir = join(sandboxRoot, `data-${variant}`);
  mkdirSync(join(dataDir, 'history'), { recursive: true });
  writeFileSync(join(dataDir, 'mixdog-config.json'), JSON.stringify(userUnified, null, 2));
  copyAuthArtifacts(realDataDir, dataDir, provider);
  return dataDir;
}

function resetTaskCwd(taskCwd) {
  writeFileSync(join(taskCwd, 'math.js'), INITIAL_MATH_JS, 'utf8');
}

function prepareTaskCwd(parentDir) {
  const taskCwd = mkdtempSync(join(parentDir, 'task-'));
  resetTaskCwd(taskCwd);
  return taskCwd;
}

function extractSessionId(text) {
  const s = String(text || '');
  const m = s.match(/sessionId:\s*(sess_[A-Za-z0-9_]+)/) || s.match(/\b(sess_[A-Za-z0-9_]+)/);
  return m ? m[1] : null;
}

function runHeadlessWorker({ pluginRoot, dataDir, taskCwd, prompt, provider, model, effort, fast }) {
  const driver = [
    `import { runHeadlessRole } from ${JSON.stringify(HEADLESS)};`,
    `const out = [];`,
    `const code = await runHeadlessRole({`,
    `  agent: 'worker',`,
    `  message: ${JSON.stringify(prompt)},`,
    `  provider: ${JSON.stringify(provider || null)},`,
    `  model: ${JSON.stringify(model || null)},`,
    `  effort: ${JSON.stringify(effort || null)},`,
    `  fast: ${JSON.stringify(fast === true)},`,
    `  cwd: ${JSON.stringify(taskCwd)},`,
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
        MIXDOG_ROOT: pluginRoot,
        MIXDOG_DATA_DIR: dataDir,
      },
    });
    ok = true;
  } catch (e) {
    raw = String(e.stdout || '') + String(e.stderr || '');
    ok = false;
  }
  return { sessionId: extractSessionId(raw), ok, ms: Date.now() - started, raw };
}

function readRows(path) {
  if (!existsSync(path)) return [];
  const rows = [];
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    if (!line) continue;
    try {
      rows.push(JSON.parse(line));
    } catch { /* tail */ }
  }
  return rows;
}

function payload(row) {
  return row?.payload && typeof row.payload === 'object' ? row.payload : {};
}

function field(row, name) {
  if (row && row[name] != null) return row[name];
  const p = payload(row);
  return p[name] != null ? p[name] : null;
}

function num(row, name) {
  const n = Number(field(row, name));
  return Number.isFinite(n) ? n : null;
}

function sessionId(row) {
  return String(row?.session_id || row?.sessionId || field(row, 'session_id') || '');
}

function sum(values) {
  return values.reduce((s, v) => s + (Number.isFinite(Number(v)) ? Number(v) : 0), 0);
}

function groupBy(rows, keyFn) {
  const map = new Map();
  for (const row of rows) {
    const key = keyFn(row);
    if (!key) continue;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(row);
  }
  return map;
}

function inferSessionMeta(rows) {
  const sorted = [...rows].sort((a, b) => Number(a.ts || 0) - Number(b.ts || 0));
  const preset = sorted.find((r) => r.kind === 'preset_assign');
  const usage = [...sorted].reverse().find((r) => r.kind === 'usage_raw' || r.kind === 'usage');
  const tool = sorted.find((r) => r.kind === 'tool');
  const last = sorted[sorted.length - 1] || {};
  const tsValues = sorted.map((r) => Number(r.ts || 0)).filter((n) => n > 0);
  return {
    session_id: sessionId(last),
    parent_session_id: field(preset, 'parent_session_id') || field(preset, 'parentSessionId') || null,
    agent: field(preset, 'agent') || field(tool, 'agent') || field(usage, 'sourceName') || field(last, 'sourceName') || null,
    min_ts: tsValues.length ? Math.min(...tsValues) : null,
    max_ts: tsValues.length ? Math.max(...tsValues) : null,
  };
}

function selectSessionFamily(sessionMetas, query) {
  const selected = sessionMetas.find((m) => m.session_id === query)
    || sessionMetas.find((m) => m.session_id.startsWith(query));
  if (!selected) return [];
  const root = selected.parent_session_id
    ? sessionMetas.find((m) => m.session_id === selected.parent_session_id) || selected
    : selected;
  const ids = new Set([root.session_id, selected.session_id]);
  for (const meta of sessionMetas) {
    if (meta.parent_session_id === root.session_id) ids.add(meta.session_id);
  }
  return [...ids].filter(Boolean);
}

function sumUsageForSession(dataDir, rootSessionId) {
  const tracePath = join(dataDir, 'history', 'agent-trace.jsonl');
  const rows = readRows(tracePath);
  const bySid = groupBy(rows, sessionId);
  const sessionMetas = [...bySid.entries()].map(([, srows]) => inferSessionMeta(srows));
  const family = selectSessionFamily(sessionMetas, rootSessionId);
  const usageRows = rows.filter((r) => r.kind === 'usage_raw' && family.includes(sessionId(r)));
  return {
    tracePath,
    session_ids: family,
    prompt_tokens: sum(usageRows.map((r) => num(r, 'prompt_tokens'))),
    output_tokens: sum(usageRows.map((r) => num(r, 'output_tokens'))),
    cached_tokens: sum(usageRows.map((r) => num(r, 'cached_tokens'))),
    usage_rows: usageRows.length,
  };
}

// ---- lead mode: multi-agent role-split token attribution -------------------

const ROLES = ['lead', 'worker', 'reviewer', 'other'];

function roleOf(agent) {
  const a = String(agent || '').toLowerCase();
  if (!a) return 'other';
  if (a === 'lead' || a === 'main') return 'lead';
  if (a.includes('review')) return 'reviewer';   // reviewer before worker (heavy-worker matches 'worker')
  if (a.includes('worker')) return 'worker';
  return 'other';
}

function emptyRoleBucket() {
  return { prompt_tokens: 0, output_tokens: 0, cached_tokens: 0, usage_rows: 0, total_tokens: 0 };
}

// Transitive closure over parent_session_id from the Lead root: collects the
// whole Lead+children session tree (worker/reviewer sessions link back via
// parent_session_id recorded on their preset_assign rows).
function collectSessionTree(sessionMetas, rootSessionId) {
  const byParent = new Map();
  for (const meta of sessionMetas) {
    const p = meta.parent_session_id || null;
    if (!byParent.has(p)) byParent.set(p, []);
    byParent.get(p).push(meta);
  }
  const ids = new Set();
  const queue = [rootSessionId];
  while (queue.length) {
    const id = queue.shift();
    if (!id || ids.has(id)) continue;
    ids.add(id);
    for (const child of byParent.get(id) || []) queue.push(child.session_id);
  }
  return ids;
}

function emptyRoleSplit(dataDir) {
  return {
    tracePath: join(dataDir, 'history', 'agent-trace.jsonl'),
    session_ids: [],
    byRole: { lead: emptyRoleBucket(), worker: emptyRoleBucket(), reviewer: emptyRoleBucket(), other: emptyRoleBucket() },
    total: { prompt_tokens: 0, output_tokens: 0, total_tokens: 0, usage_rows: 0 },
  };
}

function splitTokensByRole(dataDir, rootSessionId) {
  const tracePath = join(dataDir, 'history', 'agent-trace.jsonl');
  const rows = readRows(tracePath);
  const bySid = groupBy(rows, sessionId);
  const sessionMetas = [...bySid.entries()].map(([sid, srows]) => ({ ...inferSessionMeta(srows), session_id: sid }));
  const treeIds = collectSessionTree(sessionMetas, rootSessionId);
  const roleBySession = new Map();
  for (const meta of sessionMetas) {
    if (treeIds.has(meta.session_id)) roleBySession.set(meta.session_id, roleOf(meta.agent));
  }
  // The Lead root session is created via createSession() directly (no
  // session-builder), so it emits no preset_assign row and inferSessionMeta
  // falls back to sourceName ('internal-comms-bench-lead') which roleOf() maps
  // to 'other'. Pin the root to 'lead' explicitly. Worker/reviewer children go
  // through session-builder -> traceAgentPreset, so their agent is recorded.
  if (treeIds.has(rootSessionId)) roleBySession.set(rootSessionId, 'lead');
  const byRole = { lead: emptyRoleBucket(), worker: emptyRoleBucket(), reviewer: emptyRoleBucket(), other: emptyRoleBucket() };
  const usageRows = rows.filter((r) => r.kind === 'usage_raw' && treeIds.has(sessionId(r)));
  for (const r of usageRows) {
    const role = roleBySession.get(sessionId(r)) || 'other';
    const bucket = byRole[role] || byRole.other;
    bucket.prompt_tokens += num(r, 'prompt_tokens') || 0;
    bucket.output_tokens += num(r, 'output_tokens') || 0;
    bucket.cached_tokens += num(r, 'cached_tokens') || 0;
    bucket.usage_rows += 1;
  }
  const total = { prompt_tokens: 0, output_tokens: 0, total_tokens: 0, usage_rows: 0 };
  for (const role of ROLES) {
    byRole[role].total_tokens = byRole[role].prompt_tokens + byRole[role].output_tokens;
    total.prompt_tokens += byRole[role].prompt_tokens;
    total.output_tokens += byRole[role].output_tokens;
    total.total_tokens += byRole[role].total_tokens;
    total.usage_rows += byRole[role].usage_rows;
  }
  return { tracePath, session_ids: [...treeIds], byRole, total };
}

function median(values) {
  const arr = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (!arr.length) return 0;
  const mid = Math.floor(arr.length / 2);
  return arr.length % 2 ? arr[mid] : (arr[mid - 1] + arr[mid]) / 2;
}

function mean(values) {
  const arr = values.filter((v) => Number.isFinite(v));
  return arr.length ? sum(arr) / arr.length : 0;
}

function aggregateVariant(splits) {
  const out = { byRole: {}, total: {} };
  for (const role of ROLES) {
    const totals = splits.map((s) => s.byRole[role].total_tokens);
    out.byRole[role] = { median: median(totals), mean: mean(totals), runs: totals };
  }
  const grand = splits.map((s) => s.total.total_tokens);
  out.total = { median: median(grand), mean: mean(grand), runs: grand };
  return out;
}

// Drives a REAL Lead session in the variant sandbox (createSession/askSession/
// closeSession from the runtime manager — same pattern as output-style-bench).
// The variant rule files take effect through MIXDOG_ROOT; the runtime modules
// themselves are imported from the real PLUGIN_ROOT (identical across variants).
function runLiveLeadDelegation({ pluginRoot, dataDir, taskCwd, prompt, provider, model, effort, fast }) {
  const cfgUrl = pathToFileURL(join(PLUGIN_ROOT, 'runtime/agent/orchestrator/config.mjs')).href;
  const regUrl = pathToFileURL(join(PLUGIN_ROOT, 'runtime/agent/orchestrator/providers/registry.mjs')).href;
  const mgrUrl = pathToFileURL(join(PLUGIN_ROOT, 'runtime/agent/orchestrator/session/manager.mjs')).href;
  const driver = [
    `import * as cfgMod from ${JSON.stringify(cfgUrl)};`,
    `import * as reg from ${JSON.stringify(regUrl)};`,
    `import { createSession, askSession, closeSession } from ${JSON.stringify(mgrUrl)};`,
    `const config = cfgMod.loadConfig({ secrets: true });`,
    `await reg.initProviders(config.providers || {});`,
    `const sessionOpts = { provider: ${JSON.stringify(provider)}, model: ${JSON.stringify(model)},`,
    `  owner: 'cli', agent: 'lead', lane: 'cli', sourceType: 'lead', sourceName: 'internal-comms-bench-lead',`,
    `  cwd: ${JSON.stringify(taskCwd)}, tools: 'full', fast: ${fast ? 'true' : 'false'} };`,
    effort ? `sessionOpts.effort = ${JSON.stringify(effort)};` : '',
    `const session = createSession(sessionOpts);`,
    `let result;`,
    `try { result = await askSession(session.id, ${JSON.stringify(prompt)}, null, null, ${JSON.stringify(taskCwd)}); }`,
    `finally { try { closeSession(session.id, 'internal-comms-bench-lead'); } catch {} }`,
    `process.stdout.write(JSON.stringify({ text: String(result?.text || result?.content || '').trim(), sessionId: session.id }));`,
  ].filter(Boolean).join('\n');
  const started = Date.now();
  let raw = '';
  let ok = false;
  let sid = null;
  try {
    raw = execFileSync('node', ['--input-type=module', '-e', driver], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      env: {
        ...process.env,
        MIXDOG_ROOT: pluginRoot,
        MIXDOG_DATA_DIR: dataDir,
      },
    });
    const j = raw.lastIndexOf('{');
    if (j >= 0) { try { sid = JSON.parse(raw.slice(j)).sessionId || null; } catch { /* tail */ } }
    ok = !!sid;
  } catch (e) {
    raw = String(e.stdout || '') + String(e.stderr || '');
    const j = raw.lastIndexOf('{');
    if (j >= 0) { try { sid = JSON.parse(raw.slice(j)).sessionId || null; } catch { /* tail */ } }
    ok = false;
  }
  return { sessionId: sid || extractSessionId(raw), ms: Date.now() - started, ok, raw };
}

function fmtDeltaEntry(entry) {
  const sign = entry.delta >= 0 ? '+' : '';
  const pct = entry.pct == null ? '' : ` (${entry.pct >= 0 ? '+' : ''}${entry.pct.toFixed(1)}%)`;
  return `${sign}${Math.round(entry.delta)}${pct}`;
}

function runLeadMode({ route, effort, fast, repeat, jsonMode, leadPrompt }) {
  const realDataDir = defaultUserDataDir();
  const userUnified = readUnifiedConfig(realDataDir);
  const sandboxRoot = mkdtempSync(join(REPO_ROOT, '.tmp-internal-comms-bench-lead-'));
  const perVariant = { A: [], B: [] };
  const runsMeta = { A: [], B: [] };
  try {
    const pluginRoots = {
      A: materializePluginRoot('A', sandboxRoot),
      B: materializePluginRoot('B', sandboxRoot),
    };
    for (let i = 0; i < repeat; i += 1) {
      for (const variant of ['A', 'B']) {
        const taskCwd = prepareTaskCwd(sandboxRoot);
        const dataDir = prepareDataDir(sandboxRoot, `${variant}-r${i}`, realDataDir, userUnified, route.provider);
        process.stderr.write(`[internal-comms-bench] lead run ${i + 1}/${repeat} variant=${variant} ${route.provider}/${route.model}\n`);
        const run = runLiveLeadDelegation({
          pluginRoot: pluginRoots[variant],
          dataDir,
          taskCwd,
          prompt: leadPrompt,
          provider: route.provider,
          model: route.model,
          effort,
          fast,
        });
        const split = run.sessionId ? splitTokensByRole(dataDir, run.sessionId) : emptyRoleSplit(dataDir);
        perVariant[variant].push(split);
        runsMeta[variant].push({ ok: run.ok, ms: run.ms, sessionId: run.sessionId, total: split.total.total_tokens });
        process.stderr.write(`[internal-comms-bench]   -> ${run.ok ? 'ok' : 'FAIL'} ${Math.round(run.ms / 1000)}s session=${run.sessionId || '(none)'} total=${split.total.total_tokens} lead=${split.byRole.lead.total_tokens} worker=${split.byRole.worker.total_tokens} reviewer=${split.byRole.reviewer.total_tokens} other=${split.byRole.other.total_tokens}\n`);
      }
    }
  } finally {
    rmSync(sandboxRoot, { recursive: true, force: true });
  }

  const aggA = aggregateVariant(perVariant.A);
  const aggB = aggregateVariant(perVariant.B);
  const deltaMedian = {};
  const deltaMean = {};
  for (const role of [...ROLES, 'total']) {
    const aM = role === 'total' ? aggA.total.median : aggA.byRole[role].median;
    const bM = role === 'total' ? aggB.total.median : aggB.byRole[role].median;
    const aAvg = role === 'total' ? aggA.total.mean : aggA.byRole[role].mean;
    const bAvg = role === 'total' ? aggB.total.mean : aggB.byRole[role].mean;
    deltaMedian[role] = { delta: bM - aM, pct: pctChange(bM, aM) };
    deltaMean[role] = { delta: bAvg - aAvg, pct: pctChange(bAvg, aAvg) };
  }

  if (jsonMode) {
    console.log(JSON.stringify({
      mode: 'lead',
      route,
      repeat,
      prompt: leadPrompt,
      runs: runsMeta,
      variants: { A: { label: 'prior_verbose@HEAD', ...aggA }, B: { label: 'optimized_on_disk', ...aggB } },
      delta_B_vs_A: { median: deltaMedian, mean: deltaMean },
      note: 'single runs are noise-dominated; median+mean over --repeat N reduce run-to-run noise.',
    }, null, 2));
  } else {
    console.log(`lead-mode multi-agent ${route.provider}/${route.model} repeat=${repeat}`);
    console.log('NOTE: single runs are noise-dominated; use --repeat N to stabilize (median+mean shown).');
    for (const [id, agg] of [['A', aggA], ['B', aggB]]) {
      console.log(`variant ${id} (${id === 'A' ? 'prior_verbose@HEAD' : 'optimized_on_disk'}) per-role tokens median/mean over ${repeat} run(s):`);
      for (const role of ROLES) {
        const r = agg.byRole[role];
        console.log(`  ${role.padEnd(9)} med=${Math.round(r.median)} mean=${Math.round(r.mean)}`);
      }
      console.log(`  ${'total'.padEnd(9)} med=${Math.round(agg.total.median)} mean=${Math.round(agg.total.mean)}`);
    }
    console.log('delta B-vs-A (median): ' + [...ROLES, 'total'].map((r) => `${r}=${fmtDeltaEntry(deltaMedian[r])}`).join(' '));
    console.log('delta B-vs-A (mean):   ' + [...ROLES, 'total'].map((r) => `${r}=${fmtDeltaEntry(deltaMean[r])}`).join(' '));
  }

  const allOk = runsMeta.A.every((r) => r.ok) && runsMeta.B.every((r) => r.ok);
  const anyUsage = perVariant.A.some((s) => s.total.usage_rows > 0) || perVariant.B.some((s) => s.total.usage_rows > 0);
  process.exit(allOk && anyUsage ? 0 : 1);
}

function pctChange(b, a) {
  if (!Number.isFinite(a) || a === 0) return null;
  return ((b - a) / a) * 100;
}

function printUsage() {
  process.stdout.write(`internal-comms-bench — live A/B token effect (internal-comms rules).

Variant A = prior verbose rules from git: git show HEAD:src/<rule> (fallback: current file).
Variant B = optimized rules: current on-disk src/ copied to temp PLUGIN_ROOT.

Modes:
  --mode worker (default) — single worker task via runHeadlessRole (bench-run child pattern).
  --mode lead             — REAL internal-comms flow: a live Lead session is forced to delegate
                            one small task to a worker and then a reviewer (via the agent tool).
                            Tokens are split BY ROLE (lead/worker/reviewer/other) across the whole
                            Lead+children session tree, parsed from the sandbox agent-trace.jsonl.

Usage:
  node scripts/internal-comms-bench.mjs [--json]
  node scripts/internal-comms-bench.mjs --run [--model grok] [--provider P] [--effort E] [--fast] [--prompt "..."] [--json]
  node scripts/internal-comms-bench.mjs --run --mode lead [--repeat N] [--model grok] [--provider P] [--effort E] [--fast] [--prompt "..."] [--json]

--run required for live model calls. Sandboxes temp PLUGIN_ROOT + MIXDOG_DATA_DIR; copies OAuth JSON read-only from your real data dir.
--mode lead measures the optimization the worker mode cannot (Lead brief + agent handoff tokens).
--repeat N (default 1) runs the A/B N times and reports per-role median AND mean; single runs are noise-dominated.
`);
}

function main() {
  const jsonMode = hasFlag('--json');
  const doRun = hasFlag('--run');
  const mode = String(argValue('--mode', 'worker') || 'worker').trim().toLowerCase();
  const repeat = Math.max(1, Number.parseInt(argValue('--repeat', '1'), 10) || 1);
  const prompt = argValue('--prompt', mode === 'lead' ? DEFAULT_LEAD_PROMPT : DEFAULT_WORKER_PROMPT);
  const cli = resolveModelOpts(argValue('--model', doRun ? 'grok' : null), argValue('--provider', null));
  const effort = argValue('--effort', null);
  const fast = hasFlag('--fast');

  if (!doRun) {
    printUsage();
    const ruleStats = ruleVariantBytes();
    const aSum = sum(ruleStats.map((r) => r.a_chars));
    const bSum = sum(ruleStats.map((r) => r.b_chars));
    if (jsonMode) {
      console.log(JSON.stringify({
        mode: 'usage',
        run_mode: mode,
        repeat,
        rule_files: RULE_FILES,
        rule_stats: ruleStats,
        rule_chars: { A: aSum, B: bSum },
        liveCommand: 'node scripts/internal-comms-bench.mjs --run --model grok',
        liveLeadCommand: 'node scripts/internal-comms-bench.mjs --run --mode lead --repeat 3 --model grok',
      }, null, 2));
    } else {
      process.stdout.write(`[internal-comms-bench] rule chars A(prior@HEAD)=${aSum} B(on-disk)=${bSum} (${RULE_FILES.length} files); mode=${mode} repeat=${repeat}\n`);
    }
    process.exit(0);
  }

  const realDataDir = defaultUserDataDir();
  const userUnified = readUnifiedConfig(realDataDir);
  const route = {
    provider: cli.provider || MODEL_ALIASES.grok.provider,
    model: cli.model || MODEL_ALIASES.grok.model,
  };

  if (mode === 'lead') {
    runLeadMode({ route, effort, fast, repeat, jsonMode, leadPrompt: prompt });
    return;
  }

  const sandboxRoot = mkdtempSync(join(REPO_ROOT, '.tmp-internal-comms-bench-'));
  const results = {};
  try {
    const taskCwd = prepareTaskCwd(sandboxRoot);
    for (const variant of ['A', 'B']) {
      resetTaskCwd(taskCwd);
      const pluginRoot = materializePluginRoot(variant, sandboxRoot);
      const dataDir = prepareDataDir(sandboxRoot, variant, realDataDir, userUnified, route.provider);
      process.stderr.write(`[internal-comms-bench] variant=${variant} ${route.provider}/${route.model}\n`);
      const run = runHeadlessWorker({
        pluginRoot,
        dataDir,
        taskCwd,
        prompt,
        provider: route.provider,
        model: route.model,
        effort,
        fast,
      });
      const usage = run.sessionId
        ? sumUsageForSession(dataDir, run.sessionId)
        : {
          session_ids: [],
          prompt_tokens: 0,
          output_tokens: 0,
          cached_tokens: 0,
          usage_rows: 0,
          tracePath: join(dataDir, 'history', 'agent-trace.jsonl'),
        };
      usage.total_tokens = usage.prompt_tokens + usage.output_tokens;
      results[variant] = { ...run, usage };
      process.stderr.write(`[internal-comms-bench]   -> ${run.ok ? 'ok' : 'FAIL'} ${Math.round(run.ms / 1000)}s session=${run.sessionId || '(none)'} tokens=${usage.total_tokens}\n`);
    }
  } finally {
    rmSync(sandboxRoot, { recursive: true, force: true });
  }

  const a = results.A?.usage || {};
  const b = results.B?.usage || {};
  const delta = {
    prompt_tokens: (b.prompt_tokens || 0) - (a.prompt_tokens || 0),
    output_tokens: (b.output_tokens || 0) - (a.output_tokens || 0),
    total_tokens: (b.total_tokens || 0) - (a.total_tokens || 0),
    pct_total_B_vs_A: pctChange(b.total_tokens || 0, a.total_tokens || 0),
  };

  if (jsonMode) {
    console.log(JSON.stringify({
      mode: 'live',
      route,
      prompt,
      variants: {
        A: { label: 'prior_verbose@HEAD', run: { ok: results.A.ok, ms: results.A.ms, sessionId: results.A.sessionId }, usage: a },
        B: { label: 'optimized_on_disk', run: { ok: results.B.ok, ms: results.B.ms, sessionId: results.B.sessionId }, usage: b },
      },
      delta_B_vs_A: delta,
    }, null, 2));
  } else {
    console.log(`live worker ${route.provider}/${route.model}`);
    for (const id of ['A', 'B']) {
      const u = results[id].usage;
      console.log(`variant ${id}: ${results[id].ok ? 'ok' : 'FAIL'} prompt=${u.prompt_tokens} output=${u.output_tokens} total=${u.total_tokens} sessions=${(u.session_ids || []).length}`);
    }
    const pct = delta.pct_total_B_vs_A;
    const pctStr = pct == null ? 'n/a' : `${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%`;
    console.log(`delta B-vs-A: prompt=${delta.prompt_tokens >= 0 ? '+' : ''}${delta.prompt_tokens} output=${delta.output_tokens >= 0 ? '+' : ''}${delta.output_tokens} total=${delta.total_tokens >= 0 ? '+' : ''}${delta.total_tokens} (${pctStr})`);
  }

  const ok = results.A?.ok && results.B?.ok && (a.usage_rows > 0 || b.usage_rows > 0);
  process.exit(ok ? 0 : 1);
}

main();
