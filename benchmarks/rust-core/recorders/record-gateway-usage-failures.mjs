#!/usr/bin/env node
// Genuine Node recording of what the gateway usage writer does when a provider request fails or a turn is aborted: the
// product's own `askSession` (session/manager/ask-session.mjs) runs a real turn against a fake provider registered the way
// the product's ask-session tests do, in its own process per scenario with a fresh data dir, and the golden keeps what the
// ask settled with, how many requests the provider saw, and the store file `<data>/gateway-usage.local.jsonl` after the
// writer's pending batch is flushed (`settleGatewayUsageWrites`), byte for byte.
// Once the session exists, time is a virtual clock and the writer's timers (`setTimeout` called from route-meta.mjs) a virtual
// queue: a timer runs in order of due time, then registration order, one callback at a time, microtasks drained after each;
// the clock only moves to the due time of the timer that runs. So `ts` and `durationMs` are the recorded clock; the only
// masked field is `sessionId` (a random id minted by createSession), written as "<session>" in the store and in the error texts.
// For each ask that completed, the golden keeps the transcript and tool schemas the session held when the event was written
// (the inputs of Node's `estimateTranscriptContextUsage`), checked here to give back the event's own `compact.afterTokens`.
//
//   node benchmarks/rust-core/recorders/record-gateway-usage-failures.mjs --tree <git archive of b6f10295a, with node_modules>
// Output: native/core/fixtures/gateway-usage-failures/golden.json
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FIXTURES_ROOT, commitStage, importFrom, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } from './lib/common.mjs';

const T0 = 1_800_000_000_000;
const COMMIT = 'b6f10295a2f698afc85332467192de28500bd146';
const STORE = 'gateway-usage.local.jsonl';
const USAGE = { inputTokens: 100, outputTokens: 20, cachedTokens: 40 };

const args = parseArgs();

if (args.has('child')) {
  const spec = JSON.parse(readFileSync(args.get('child'), 'utf8'));
  const tree = resolveTree(args);
  process.env.MIXDOG_DATA_DIR = spec.dataDir;
  process.env.MIXDOG_AGENT_TRACE_DISABLE = '1';
  mkdirSync(spec.dataDir, { recursive: true });
  const { createSession } = await importFrom(tree, 'src/runtime/agent/orchestrator/session/manager/session-lifecycle.mjs');
  const { askSession } = await importFrom(tree, 'src/runtime/agent/orchestrator/session/manager/ask-session.mjs');
  const { abortSessionTurn } = await importFrom(tree, 'src/runtime/agent/orchestrator/session/manager/session-close.mjs');
  const { _withRegisteredProviderForTestAsync } = await importFrom(tree, 'src/runtime/agent/orchestrator/providers/registry.mjs');
  const { modelToolSchemaAllowlist } = await importFrom(tree, 'src/runtime/agent/orchestrator/runtime-core/tool-profile.mjs');
  const { settleGatewayUsageWrites } = await importFrom(tree, 'src/vendor/statusline/src/gateway/route-meta.mjs');
  const { _liveSessions } = await importFrom(tree, 'src/runtime/agent/orchestrator/session/store/live-state.mjs');
  const { estimateTranscriptContextUsage } = await importFrom(tree, 'src/runtime/agent/orchestrator/session/context-utils.mjs');
  // The telemetry reaches route-meta through a lazy wrapper that throws on its first call while the module loads: that first
  // event of a process is lost in Node unless the footer loaded the module first. Loaded here as a TUI process has.
  const wrapper = await importFrom(tree, 'src/runtime/agent/orchestrator/providers/statusline-route-meta.mjs');
  try { wrapper.summarizeGatewayUsage({}, {}); } catch { /* starts the load */ }
  await importFrom(tree, 'src/vendor/statusline/src/gateway/route-meta.mjs');

  let clock = T0;
  let timerSeq = 0;
  const queue = new Map();
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  // Time passes until no timer is left: the earliest due timer (then the earliest registered) runs alone, and the microtasks
  // and I/O callbacks it started are drained before the next one is chosen.
  const runTimers = async () => {
    while (queue.size > 0) {
      const next = [...queue.values()].sort((a, b) => a.due - b.due || a.id - b.id)[0];
      queue.delete(next.id);
      clock = Math.max(clock, next.due);
      next.fn();
      await new Promise((resolve) => setImmediate(resolve));
    }
  };

  const sends = [];
  let reply = async () => ({ content: 'answer', usage: USAGE });
  const provider = {
    name: 'ask-session-turn-test',
    contextWindow: 128000,
    async send(messages, model, _tools, sendOpts) {
      sends.push(messages.length);
      return reply(messages, sendOpts, sends.length);
    },
  };
  const outcomes = [];
  const asks = [];
  const ask = async (sessionId, prompt, opts = {}) => {
    try {
      const result = await askSession(sessionId, prompt, null, null, null, null, opts);
      outcomes.push({ prompt, resolved: result.content });
      const live = _liveSessions.get(sessionId);
      asks.push(JSON.parse(JSON.stringify({ provider: live.provider, contextWindow: live.contextWindow ?? null, messages: live.messages, tools: live.tools || [] })));
    } catch (error) {
      outcomes.push({ prompt, rejected: error?.constructor?.name, message: String(error?.message || error) });
    }
  };
  const failing = async () => { throw Object.assign(new Error('provider exploded'), { httpStatus: 400 }); };
  const hanging = (stop) => (_messages, sendOpts) => new Promise((_, reject) => {
    sendOpts.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    stop();
  });
  let sessionId = '';
  await _withRegisteredProviderForTestAsync(provider.name, provider, async () => {
    const session = createSession({
      provider: provider.name, model: 'fake-model', cwd: spec.dataDir, skipSkills: true,
      schemaAllowedTools: modelToolSchemaAllowlist('headless'), workflow: { id: 'headless', delegatesAgents: false },
    });
    sessionId = session.id;
    Date.now = () => clock;
    globalThis.setTimeout = (fn, ms, ...rest) => {
      // Other subsystems' timers run for real; the writer's are the queue's.
      if (!new Error().stack.includes('route-meta.mjs')) return realSetTimeout(fn, ms, ...rest);
      const timer = { id: ++timerSeq, due: clock + Math.max(0, Number(ms) || 0), fn: () => fn(...rest), unref() { return timer; }, ref() { return timer; } };
      queue.set(timer.id, timer);
      return timer;
    };
    globalThis.clearTimeout = (timer) => (timer && queue.has(timer.id) ? void queue.delete(timer.id) : realClearTimeout(timer));
    const set = (fn) => { reply = fn; };
    const scenarios = {
      async completed() { await ask(sessionId, 'hello'); },
      async 'provider failure'() { set(failing); await ask(sessionId, 'will fail'); },
      async 'abort mid-stream by the turn abort'() {
        set(hanging(() => setImmediate(() => abortSessionTurn(sessionId, 'user-cancel'))));
        await ask(sessionId, 'will abort');
      },
      async 'abort mid-stream by the caller signal'() {
        const controller = new AbortController();
        set(hanging(() => controller.abort(new Error('user stop'))));
        await ask(sessionId, 'will abort', { signal: controller.signal });
      },
      async 'provider failure after a completed tool iteration'() {
        set(async (_messages, _opts, n) => {
          if (n === 1) return { content: '', usage: USAGE, toolCalls: [{ id: 'call_1', name: 'read', arguments: { path: 'missing.log' } }] };
          throw Object.assign(new Error('provider exploded'), { httpStatus: 400 });
        });
        await ask(sessionId, 'will fail late');
      },
      async 'a failed turn then a completed one'() {
        set(failing);
        await ask(sessionId, 'will fail');
        set(async () => ({ content: 'recovered', usage: USAGE }));
        await ask(sessionId, 'after failure');
      },
      async 'an abort then a completed turn'() {
        set(hanging(() => setImmediate(() => abortSessionTurn(sessionId, 'user-cancel'))));
        await ask(sessionId, 'will abort');
        set(async () => ({ content: 'recovered', usage: USAGE }));
        await ask(sessionId, 'after abort');
      },
      async 'an abort the provider ignores until it has a result'() {
        set(async () => {
          abortSessionTurn(sessionId, 'user-cancel');
          return { content: 'late answer', usage: USAGE };
        });
        await ask(sessionId, 'aborted but answered');
      },
    };
    await scenarios[spec.name]();
  });
  await runTimers();
  await settleGatewayUsageWrites();
  await runTimers();
  if (queue.size !== 0) throw new Error('a writer timer is left');
  const store = join(spec.dataDir, STORE);
  const raw = existsSync(store) ? readFileSync(store, 'utf8') : null;
  const events = raw === null ? [] : raw.split('\n').filter(Boolean).map((line) => JSON.parse(line));
  if (events.length !== asks.length) throw new Error(`${spec.name}: ${events.length} events for ${asks.length} completed asks`);
  events.forEach((event, index) => {
    const held = asks[index];
    const estimate = estimateTranscriptContextUsage(held.messages, held.tools, { provider: held.provider });
    if (held.messages.length !== event.messageCount || estimate !== event.compact.afterTokens) {
      throw new Error(`${spec.name}: ask ${index} held ${held.messages.length} messages estimating ${estimate}; the event has ${event.messageCount} and ${event.compact.afterTokens}`);
    }
  });
  // The held transcripts are kept unmasked: a session id inside one would change its estimate.
  if (JSON.stringify(asks).includes(sessionId)) throw new Error(`${spec.name}: the session id is inside a held transcript`);
  const text = raw === null ? null : raw.split(sessionId).join('<session>');
  const masked = outcomes.map((o) => ({ ...o, ...(o.message ? { message: o.message.split(sessionId).join('<session>') } : {}) }));
  process.stdout.write(`${JSON.stringify({ outcomes: masked, sends, asks, store: text })}\n`);
  process.exit(0);
} else {
  const tree = resolveTree(args);
  const finalDir = join(FIXTURES_ROOT, 'gateway-usage-failures');
  const stage = stageSet(finalDir);
  const sandbox = mkdtempSync(join(process.env.TEMP || tmpdir(), 'gateway-usage-failures-'));
  const self = fileURLToPath(import.meta.url);
  const names = [
    'completed',
    'provider failure',
    'abort mid-stream by the turn abort',
    'abort mid-stream by the caller signal',
    'provider failure after a completed tool iteration',
    'a failed turn then a completed one',
    'an abort then a completed turn',
    'an abort the provider ignores until it has a result',
  ];
  const cases = names.map((name, index) => {
    const dataDir = join(sandbox, `case-${index}`);
    const specFile = join(sandbox, `case-${index}.json`);
    writeFileSync(specFile, JSON.stringify({ name, dataDir }));
    const run = spawnSync(process.execPath, [self, '--child', specFile, '--tree', tree], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env: { ...process.env, TZ: 'UTC' } });
    if (run.status !== 0) throw new Error(`${name}: ${run.stderr}`);
    return { name, ...JSON.parse(run.stdout.trim().split('\n').at(-1)) };
  });
  rmSync(sandbox, { recursive: true, force: true });
  writeJson(join(stage, 'golden.json'), {
    note: 'the store file after a real askSession turn against a fake provider; sessionId is masked, the clock is fixed',
    start: T0,
    usage: USAGE,
    cases,
  });
  writeSetManifest(stage, {
    set: 'gateway-usage-failures',
    recorder: 'benchmarks/rust-core/recorders/record-gateway-usage-failures.mjs',
    command: `node benchmarks/rust-core/recorders/record-gateway-usage-failures.mjs --tree <git archive of ${COMMIT} with node_modules>`,
    extra: { cases: cases.length },
    identityTree: tree,
    identityRef: COMMIT,
  });
  commitStage(stage, finalDir);
  console.log(`cases=${cases.length}`);
}
