#!/usr/bin/env node
// Genuine Node recording of the gateway usage writer (`<data>/gateway-usage.local.jsonl`): the product's own
// `recordStandaloneStatusTelemetry` (session/manager/status-telemetry.mjs) over `route-meta.mjs`'s batching, flush,
// store lock, compaction and legacy-file migration, on a fresh data dir per case, each case in its own process (the
// writer keeps its state per process). After the steps the golden holds every file of the data dir byte for byte
// (files over 64 KiB as length, line count and sha256), the delays of the timers Node set (`setTimeout` is replaced
// by a recorder that keeps the callbacks; a `fire` step runs one, so no wait is ever slept), and its stderr.
// `Date.now` is fixed by the `clock` steps, so no field of the file is masked: the timestamps are the recorded clock.
//
//   node benchmarks/rust-core/recorders/record-gateway-usage.mjs --tree <git archive of b6f10295a, with node_modules>
// Output: native/core/fixtures/gateway-usage/golden.json
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FIXTURES_ROOT, commitStage, importFrom, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } from './lib/common.mjs';

const T0 = 1_800_000_000_000;
const BIG = 64 * 1024;
const COMMIT = 'b6f10295a2f698afc85332467192de28500bd146';

/** The seeded event lines: line i is a fixed object, so the Rust replay generates the same bytes. */
function generate(spec) {
  let out = '';
  for (let i = 0; i < spec.lines; i += 1) {
    out += `${JSON.stringify({ ts: spec.base + i * 1000, provider: 'seed', model: 'm', costUsd: 0, n: i, pad: 'x'.repeat(spec.pad) })}\n`;
  }
  return out;
}

const args = parseArgs();

if (args.has('child')) {
  // ---- child: one case in its own process -----------------------------------------------------------------------
  const spec = JSON.parse(readFileSync(args.get('child'), 'utf8'));
  const tree = resolveTree(args);
  await importFrom(tree, 'src/runtime/shared/llm/usage-test-support.mjs'); // the models.dev rates the cost reads
  const modelsdev = JSON.parse(readFileSync(join(process.env.MIXDOG_DATA_DIR, 'modelsdev-catalog.json'), 'utf8')).data;
  const { warmCatalogFromDisk } = await importFrom(tree, 'src/runtime/shared/llm/model-catalog.mjs');
  await warmCatalogFromDisk(); // reads the catalog from the support's scratch dir, before the data dir becomes the case's
  process.env.MIXDOG_DATA_DIR = spec.dataDir;
  const { recordStandaloneStatusTelemetry } = await importFrom(tree, 'src/runtime/agent/orchestrator/session/manager/status-telemetry.mjs');
  const { settleGatewayUsageWrites } = await importFrom(tree, 'src/vendor/statusline/src/gateway/route-meta.mjs');
  // The telemetry reaches route-meta through a lazy wrapper (providers/statusline-route-meta.mjs) that throws on its
  // first call while the module loads, which the telemetry swallows: that first event of a process is lost in Node
  // unless the TUI's footer loaded the module first. The recorder loads it before the steps, as a TUI process does;
  // the first call below throws by design and records nothing.
  const wrapper = await importFrom(tree, 'src/runtime/agent/orchestrator/providers/statusline-route-meta.mjs');
  try { wrapper.summarizeGatewayUsage({}, {}); } catch { /* starts the load */ }
  await importFrom(tree, 'src/vendor/statusline/src/gateway/route-meta.mjs');
  const { estimateTranscriptContextUsage } = await importFrom(tree, 'src/runtime/agent/orchestrator/session/context-utils.mjs');
  let clock = T0;
  Date.now = () => clock;
  const timers = [];
  const waiters = [];
  // Installed after every import and the catalog warm-up: only the writer's timers are kept.
  const realSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (fn, ms, ...rest) => {
    // Other subsystems' timers (the provider registry's) run for real; the writer's are the recorded ones.
    if (!new Error().stack.includes('route-meta.mjs')) return realSetTimeout(fn, ms, ...rest);
    const timer = { fn, ms, cleared: false, fired: false, unref() { return this; } };
    timers.push(timer);
    for (const waiter of waiters.filter((w) => w.ms === ms)) waiter.resolve();
    return timer;
  };
  globalThis.clearTimeout = (timer) => {
    if (timer) timer.cleared = true;
  };
  const steps = [];
  for (const step of spec.steps) {
    if (step.op === 'clock') {
      clock = step.now;
    } else if (step.op === 'ask') {
      const session = step.session;
      const estimated = estimateTranscriptContextUsage(session.messages, session.tools || [], { provider: session.provider });
      recordStandaloneStatusTelemetry(session, step.result, step.durationMs);
      steps.push({ ...step, estimatedTokens: estimated, now: clock });
      continue;
    } else if (step.op === 'await-timer') {
      // The compaction timer is set when a flush has landed: wait for the event, never for time.
      if (!timers.some((t) => !t.cleared && !t.fired && t.ms === step.ms)) await new Promise((resolve) => waiters.push({ ms: step.ms, resolve }));
    } else if (step.op === 'fire') {
      const timer = timers.find((t) => !t.cleared && !t.fired && t.ms === step.ms);
      if (!timer) throw new Error(`no pending ${step.ms} ms timer in "${spec.name}": ${JSON.stringify(timers.map((t) => [t.ms, t.cleared, t.fired]))}`);
      timer.fired = true;
      timer.fn();
    } else if (step.op === 'settle') {
      await settleGatewayUsageWrites();
    } else if (step.op === 'exit') {
      process.stdout.write(`${JSON.stringify({ modelsdev, timers: timers.map((t) => ({ ms: t.ms, cleared: t.cleared, fired: t.fired })), steps: [...steps, step] })}\n`);
      // 'exit' runs flushGatewayUsageEventsSync; the parent reads the files after this process ended.
      process.exit(0);
    }
    steps.push(step);
  }
  process.stdout.write(`${JSON.stringify({ modelsdev, timers: timers.map((t) => ({ ms: t.ms, cleared: t.cleared, fired: t.fired })), steps })}\n`);
  // Leaves through beforeExit: the writer flushes what is pending, as at the end of a Node process.
  process.exitCode = 0;
} else {
  // ---- parent -----------------------------------------------------------------------------------------------------
  const tree = resolveTree(args);
  const finalDir = join(FIXTURES_ROOT, 'gateway-usage');
  const stage = stageSet(finalDir);
  const sandbox = mkdtempSync(join(process.env.TEMP || tmpdir(), 'gateway-usage-'));

  const message = (role, text, extra = {}) => ({ role, content: text, ...extra });
  const baseMessages = [
    message('system', 'You are the lead agent.'),
    message('user', 'Summarize the repository layout.', { meta: { effortConfiguration: { version: 1, effort: 'high' } } }),
    message('assistant', 'The repository has a Rust workspace under native/core and a Node runtime under src.'),
  ];
  const tools = [{ name: 'read', description: 'Read a file', inputSchema: { type: 'object', properties: { path: { type: 'string' } } } }];
  const session = (extra = {}) => ({
    id: 'sess_1', provider: 'anthropic', model: 'claude-opus-4-8', effort: 'medium', contextWindow: 200000, rawContextWindow: 400000,
    sourceType: 'lead', agent: 'lead', messages: baseMessages, tools, ...extra,
  });
  const result = (usage, extra = {}) => ({ content: 'done', model: 'claude-opus-4-8', usage, toolCallsTotal: 2, iterations: 3, ...extra });
  const ask = (s, r, durationMs = 1234.6) => ({ op: 'ask', session: s, result: r, durationMs });

  const api = ask(session(), result({ inputTokens: 1200, outputTokens: 300, cachedTokens: 5000, cacheWriteTokens: 700, cacheWrite1hTokens: 200, raw: { input_tokens: 1200, output_tokens: 300, cache_read_input_tokens: 5000 } }));
  const grok = ask(session({ provider: 'xai', model: 'grok-4.20', effort: '', fast: true }), result({ inputTokens: 900, outputTokens: 100, cachedTokens: 300, raw: { prompt_tokens: 900 } }, { model: 'grok-4.20' }));
  const providerCost = ask(session({ provider: 'xai', model: 'grok-4.20' }), result({ inputTokens: 10, outputTokens: 2, costUsd: 0.5 }, { model: 'grok-4.20' }));
  const oauth = ask(session({ provider: 'openai-oauth', model: 'gpt-5', effort: 'high', providerCacheOpts: { cacheStrategy: { messages: '5m', tools: '1h', empty: '' } } }),
    result({ inputTokens: 2000, outputTokens: 400, cachedTokens: 1500, raw: { input_tokens: 2000, service_tier: 'priority' } }, {
      model: 'gpt-5-2026-01-01', serviceTier: 'priority',
      transportTiming: { transport: 'ws', outcome: 'completed', admissionQueueWaitMs: 12.4, providerConcurrentRequests: 2, providerQueuedRequests: 0, poolOwnerWaitMs: 0.6, socketAcquireMs: 30.5, poolAcquireMs: 31, requestBuildSerializationMs: 4.5, preResponseCreatedMs: 210.2, providerFirstEventMs: 380, retryBackoffMs: 0, handshakeRetries: 1, acquireAttempts: 2, acquireMode: ' reuse ' },
    }));
  const noContextWindow = ask(session({ provider: 'openai', model: 'gpt-x', contextWindow: 0, rawContextWindow: 0, messages: [] }), result({ inputTokens: 50, outputTokens: 5 }, { model: '' }));
  const numberedEffort = ask(session({ id: 'sess_2', sourceType: 'agent', sourceName: 'explorer', agent: undefined, messages: [message('user', 'Hi')] }), result({ inputTokens: 7, outputTokens: 1 }));
  const noProvider = ask(session({ provider: '' }), result({ inputTokens: 1, outputTokens: 1 }));
  const noModel = ask(session({ model: undefined }), result({ inputTokens: 1, outputTokens: 1 }));
  const noUsage = ask(session(), { content: 'x', model: 'm' });
  const routeAt = (n, extra) => [{ op: 'clock', now: T0 + n * 60_000 }, ask(session(extra), result({ inputTokens: 10 * n, outputTokens: 1 }))];
  const manyAsks = Array.from({ length: 25 }, (_, i) => [{ op: 'clock', now: T0 + i * 100 }, ask(session({ id: `sess_${i}` }), result({ inputTokens: 100 + i, outputTokens: 10 }), 50 + i)]).flat();

  const legacyEvents = (n, extra = {}) => Array.from({ length: n }, (_, i) => ({ ts: T0 - (n - i) * 1000, provider: 'anthropic', model: 'claude-opus-4-8', costUsd: 0.1 + i * 0.2, inputTokens: i, nested: { 'b': 1, a: [1.0, 1e21, 0.30000000000000004] }, text: 'é𝄞', ...extra }));
  const legacyJson = (events) => JSON.stringify({ version: 1, events });
  const small = { gen: { lines: 8000, pad: 40, base: T0 - 9_000_000 } };
  const huge = { gen: { lines: 8000, pad: 1100, base: T0 - 9_000_000 } };
  const bigLines = { gen: { lines: 100, pad: 100_000, base: T0 - 9_000_000 } };
  const aSettled = [{ op: 'clock', now: T0 + 5000 }];

  const cases = [
    { name: 'an API route with catalog cost, a cached prompt and one-hour cache writes', steps: [...aSettled, api, { op: 'settle' }] },
    { name: 'a provider-reported cost, a fast route without effort, and catalog cost of a second model', steps: [...aSettled, providerCost, grok, { op: 'settle' }] },
    { name: 'an OAuth route with a response model, service tier, transport timing and cache strategy', steps: [...aSettled, oauth, { op: 'settle' }] },
    { name: 'no window: the provider footprint is the context figure; an empty transcript; an agent source', steps: [...aSettled, noContextWindow, numberedEffort, { op: 'settle' }] },
    { name: 'a session without provider or model, and a result without usage, record nothing', steps: [...aSettled, noProvider, noModel, noUsage, { op: 'settle' }] },
    { name: 'the route section starts when the route identity changes', steps: [...routeAt(0, {}), ...routeAt(1, {}), ...routeAt(2, { model: 'claude-sonnet-4' }), ...routeAt(3, {}), ...routeAt(4, { effort: 'high' }), { op: 'settle' }] },
    { name: 'twenty events flush at once, the rest wait for the half-second timer', steps: [...manyAsks, { op: 'fire', ms: 500 }, { op: 'settle' }] },
    { name: 'a timer flush then a settle write two batches', steps: [...aSettled, api, { op: 'fire', ms: 500 }, { op: 'settle' }, grok, { op: 'settle' }] },
    { name: 'the last batch is written synchronously when the process exits', steps: [...aSettled, api, oauth, grok, { op: 'exit' }] },
    { name: 'a torn last line is ended by the next batch', seed: { 'gateway-usage.local.jsonl': { text: '{"ts":1,"provider":"torn"' } }, steps: [...aSettled, api, { op: 'settle' }] },
    { name: 'a store over 8 MiB with over 7500 lines is cut to the newest 5000 after the flush', seed: { 'gateway-usage.local.jsonl': huge }, steps: [...aSettled, api, { op: 'fire', ms: 500 }, { op: 'await-timer', ms: 1000 }, { op: 'fire', ms: 1000 }, { op: 'settle' }] },
    { name: 'the compaction runs at settle without waiting for its timer', seed: { 'gateway-usage.local.jsonl': huge }, steps: [...aSettled, api, { op: 'settle' }] },
    { name: 'a store over 8 MiB with at most 7500 lines is left as it is', seed: { 'gateway-usage.local.jsonl': bigLines }, steps: [...aSettled, api, { op: 'settle' }] },
    { name: 'a store of many small lines stays below the size gate and is not compacted', seed: { 'gateway-usage.local.jsonl': small }, steps: [...aSettled, api, { op: 'settle' }] },
    { name: 'the legacy JSON document becomes the store and is renamed to its backup', seed: { 'gateway-usage.local.json': { text: legacyJson(legacyEvents(3)) } }, steps: [...aSettled, api, { op: 'settle' }] },
    { name: 'a legacy document keeps its newest 5000 events', seed: { 'gateway-usage.local.json': { text: legacyJson(legacyEvents(5200)) } }, steps: [...aSettled, api, { op: 'settle' }] },
    { name: 'a legacy document beside an earlier backup gets a timestamped one', seed: { 'gateway-usage.local.json': { text: legacyJson(legacyEvents(2)) }, 'gateway-usage.local.json.migrated.bak': { text: 'earlier' } }, steps: [...aSettled, api, { op: 'settle' }] },
    { name: 'a legacy document beside an existing store is only renamed', seed: { 'gateway-usage.local.json': { text: legacyJson(legacyEvents(2)) }, 'gateway-usage.local.jsonl': { text: '{"ts":5,"provider":"kept"}\n' } }, steps: [...aSettled, api, { op: 'settle' }] },
    { name: 'a corrupt legacy document migrates to an empty store', seed: { 'gateway-usage.local.json': { text: '{"events":[' } }, steps: [...aSettled, api, { op: 'settle' }] },
    { name: 'a legacy document without an events array migrates to an empty store', seed: { 'gateway-usage.local.json': { text: '{"version":1}' } }, steps: [...aSettled, api, { op: 'settle' }] },
    // The store a 1.4.5 profile holds (fixtures/migration-145), which the profile migration leaves byte for byte.
    { name: 'the store of a 1.4.5 profile takes one more request after the migration', seed: { 'gateway-usage.local.jsonl': { text: readFileSync(join(FIXTURES_ROOT, 'migration-145', '.mixdog', 'data', 'gateway-usage.local.jsonl'), 'utf8') } }, steps: [...aSettled, api, { op: 'settle' }] },
    { name: 'a lock left by a dead process is reclaimed and removed', seed: { 'gateway-usage.local.jsonl.lock': { text: '4294967 1700000000000 deadtoken\n' } }, steps: [...aSettled, api, { op: 'settle' }] },
  ];

  const snapshot = (dir) => {
    const files = {};
    for (const name of readdirSync(dir).sort()) {
      const data = readFileSync(join(dir, name));
      files[name] = data.length > BIG
        ? { bytes: data.length, lines: data.toString('utf8').split('\n').filter((l) => l.trim()).length, sha256: createHash('sha256').update(data).digest('hex') }
        : { text: data.toString('utf8') };
    }
    return files;
  };

  const self = fileURLToPath(import.meta.url);
  const out = [];
  let modelsdev = null;
  for (const [index, spec] of cases.entries()) {
    const dataDir = join(sandbox, `case-${index}`);
    mkdirSync(dataDir, { recursive: true });
    for (const [name, seed] of Object.entries(spec.seed || {})) writeFileSync(join(dataDir, name), seed.gen ? generate(seed.gen) : seed.text);
    const specFile = join(sandbox, `case-${index}.json`);
    writeFileSync(specFile, JSON.stringify({ name: spec.name, dataDir, steps: spec.steps }));
    const run = spawnSync(process.execPath, [self, '--child', specFile, '--tree', tree], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env: { ...process.env, TZ: 'UTC' } });
    if (run.status !== 0) throw new Error(`${spec.name}: ${run.stderr}`);
    const child = JSON.parse(run.stdout.trim().split('\n').at(-1));
    modelsdev = child.modelsdev;
    out.push({ name: spec.name, seed: spec.seed || {}, steps: child.steps, timers: child.timers, stderr: run.stderr.split('\n').filter((l) => !/^\(node:\d+\) |^\(Use `node /.test(l)).join('\n'), files: snapshot(dataDir) });
  }
  rmSync(sandbox, { recursive: true, force: true });
  writeJson(join(stage, 'golden.json'), {
    note: 'every file of the data dir after each case, written by the product\'s recordStandaloneStatusTelemetry; ask steps carry the transcript estimate Node computed',
    start: T0,
    modelsdev,
    cases: out,
  });
  writeSetManifest(stage, {
    set: 'gateway-usage',
    recorder: 'benchmarks/rust-core/recorders/record-gateway-usage.mjs',
    command: `node benchmarks/rust-core/recorders/record-gateway-usage.mjs --tree <git archive of ${COMMIT} with node_modules>`,
    extra: { cases: out.length },
    identityTree: tree,
    identityRef: COMMIT,
  });
  commitStage(stage, finalDir);
  console.log(`cases=${out.length}`);
}
