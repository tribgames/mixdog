#!/usr/bin/env node
// What Node's `makeAgentDispatch` (agent-runtime/agent-dispatch.mjs) and the inline host's
// `agentDispatch` (standalone/session-runtime-inline-host/agent-dispatch.mjs) do for one
// dispatch, recorded from the real code over the real session manager, session builder, hidden-
// agent definitions, resource admission and progress watchdog, with a stub provider registered
// under the name `stub`. Spies wrap the manager calls the dispatch makes, so the golden is the
// ordered conversation between the dispatch and its collaborators (admission, preset, prepare
// spec, status, ask, close) plus what the caller got back and what the stub provider was sent.
//
// Isolation: every user directory the product reads is a fresh temp directory before any Mixdog
// module loads (the same keys as session/loop/test-isolation.mjs), and no real provider is reachable.
//
//   node benchmarks/rust-core/recorders/record-agent-dispatch.mjs [--tree <dir>]
//
// Output: native/core/fixtures/agent-dispatch/golden.json.
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FIXTURES_ROOT, commitStage, importFrom, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } from './lib/common.mjs';

const sandbox = mkdtempSync(join(tmpdir(), 'agent-dispatch-'));
for (const key of [
  'HOME',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
  'MIXDOG_HOME',
  'MIXDOG_DATA_DIR',
  'MIXDOG_CONFIG_DIR',
  'MIXDOG_RUNTIME_ROOT',
  'MIXDOG_USER_DATA_BACKUP_ROOT',
  'CODEX_HOME',
  'CLAUDE_CONFIG_DIR',
]) {
  const directory = join(sandbox, key);
  mkdirSync(directory);
  process.env[key] = directory;
}
process.env.MIXDOG_AGENT_TRACE_DISABLE = '1';
const tree = resolveTree(parseArgs());
const finalDir = join(FIXTURES_ROOT, 'agent-dispatch');
const stage = stageSet(finalDir);
const recorder = 'benchmarks/rust-core/recorders/record-agent-dispatch.mjs';
const at = (path) => importFrom(tree, path);

const { makeAgentDispatch } = await at('src/runtime/agent/orchestrator/agent-runtime/agent-dispatch.mjs');
const { createInlineAgentDispatch } = await at('src/standalone/session-runtime-inline-host/agent-dispatch.mjs');
const { prepareAgentSession } = await at('src/runtime/agent/orchestrator/agent-runtime/session-builder.mjs');
const manager = await at('src/runtime/agent/orchestrator/session/manager.mjs');
const { _withRegisteredProviderForTestAsync } = await at('src/runtime/agent/orchestrator/providers/registry.mjs');
const { resourceAdmission } = await at('src/runtime/shared/resource-admission.mjs');
const { deleteSession } = await at('src/runtime/agent/orchestrator/session/store.mjs');
const internal = await at('src/runtime/agent/orchestrator/internal-agents.mjs');
// The hidden-agent definitions the dispatch consults, as Node loads them.
const hidden = Object.fromEntries(internal.listHiddenAgentNames().map((name) => [name, internal.getHiddenAgent(name)]));

const mask = (value) => JSON.parse(JSON.stringify(value, (_k, v) => (typeof v === 'string' ? v.replace(/sess_[0-9a-z_]+/gi, '<session>') : v)));
const keep = (object, keys) => Object.fromEntries(keys.filter((key) => object?.[key] !== undefined).map((key) => [key, object[key]]));

const STUB = { provider: 'stub', model: 'stub-model' };
const CYCLE = { agent: 'cycle1-agent', taskType: 'maintenance', sourceType: 'memory-cycle', brief: false };

// How the stub provider answers one send: text, a throw, or a hang that ends with the signal.
function stubProvider(script, sends) {
  return {
    name: 'stub',
    contextWindow: 128000,
    async send(messages, model, tools, opts) {
      const user = [...messages].reverse().find((message) => message.role === 'user');
      sends.push({
        model,
        roles: messages.map((message) => message.role),
        user: typeof user?.content === 'string' ? user.content : user?.content ?? null,
        tools: (tools || []).map((tool) => tool.name),
        effort: opts?.effort ?? null,
        signal: Boolean(opts?.signal),
      });
      const behaviour = script[Math.min(sends.length - 1, script.length - 1)];
      if (behaviour.fail) throw new Error(behaviour.fail);
      // Output that began and then went silent: only then does the idle deadline apply.
      if (behaviour.streamThenHang) await opts.onStreamDelta?.('text');
      if (behaviour.hang || behaviour.streamThenHang) {
        await new Promise((_resolve, reject) => {
          opts.signal.addEventListener('abort', () => reject(opts.signal.reason ?? new Error('aborted')), { once: true });
        });
      }
      return { content: behaviour.reply ?? 'reply text', toolCalls: behaviour.toolCalls ?? [], stopReason: behaviour.toolCalls ? 'tool_use' : 'end_turn', usage: { inputTokens: 10, outputTokens: 5 } };
    },
  };
}

// One dispatch: the factory options, the call, and how the stub behaves.
async function run(scenario) {
  const events = [];
  const sends = [];
  const stderr = [];
  const write = process.stderr.write;
  process.stderr.write = (chunk, ...rest) => {
    stderr.push(String(chunk));
    return typeof rest.at(-1) === 'function' ? rest.at(-1)() : true;
  };
  const sessions = [];
  const spies = {
    prepareAgentSession: (spec) => {
      events.push(['prepare', keep(spec, ['agent', 'presetName', 'preset', 'permission', 'cwd', 'sourceType', 'sourceName', 'parentSessionId', 'ownerSessionId', 'skipRoleReminder', 'schemaAllowedTools', 'taskType', 'contextPercent', 'contextTokens', 'selectedContextWindow']), { lane: spec.runtimeSpec?.lane ?? null }]);
      const prepared = prepareAgentSession(spec);
      sessions.push(prepared.session.id);
      return prepared;
    },
    updateSessionStatus: async (id, status) => {
      events.push(['status', status]);
      return manager.updateSessionStatus(id, status);
    },
    closeSession: async (id, reason) => {
      events.push(['close', reason]);
      return manager.closeSession(id, reason);
    },
    askSession: async (id, prompt, a, onToolCall, cwd, x, askOpts) => {
      events.push(['ask', { prompt, cwd: cwd ?? null, onToolCall: typeof onToolCall, askOpts: Object.keys(askOpts || {}).sort(), liveProjection: askOpts?.liveProjection === true }]);
      return manager.askSession(id, prompt, a, onToolCall, cwd, x, askOpts);
    },
    getSession: manager.getSession,
    resourceAdmission: {
      acquire: async (kind, options) => {
        events.push(['admission.acquire', kind, { label: options.label, ownerKey: options.ownerKey ?? null, signal: Boolean(options.signal), aborted: options.signal?.aborted === true }]);
        if (scenario.admissionFails) throw new Error(scenario.admissionFails);
        const lease = await resourceAdmission.acquire(kind, options);
        return { release: async () => { events.push(['admission.release']); await lease.release(); }, inner: lease };
      },
      runWithLease: async (lease, task) => {
        events.push(['admission.run']);
        return resourceAdmission.runWithLease(lease.inner, task);
      },
    },
  };
  const controller = new AbortController();
  const outcome = {};
  try {
    await _withRegisteredProviderForTestAsync('stub', stubProvider([].concat(scenario.stub ?? {}), sends), async () => {
      const options = { ...(scenario.options || {}), ...spies };
      const call = { prompt: 'summarise the rows', ...(scenario.call || {}) };
      if (scenario.abortAfterMs !== undefined) {
        call.parentSignal = controller.signal;
        setTimeout(() => controller.abort(scenario.salvage ? Object.assign(new Error('deadline'), { salvagePartial: true }) : new Error('parent aborted')), scenario.abortAfterMs);
      }
      const keepAlive = setInterval(() => {}, 100);
      try {
        outcome.ok = await makeAgentDispatch({ agent: CYCLE.agent, ...options })(call);
      } catch (error) {
        outcome.error = error?.message ?? String(error);
      } finally {
        clearInterval(keepAlive);
      }
    });
  } finally {
    process.stderr.write = write;
    for (const id of sessions) deleteSession(id, { deferSummaryUpdate: true });
  }
  // Only the dispatch's own diagnostics; the elapsed time is a measurement, not a fact.
  const lines = stderr.filter((line) => line.startsWith('[agent-dispatch]')).map((line) => line.replace(/elapsed=\d+ms/, 'elapsed=<ms>'));
  const { id, ...input } = scenario;
  return mask({ id, input, events, sends, stderr: lines, outcome });
}

// An answer that asks for a tool, so the run commits an assistant row before the next send hangs.
const FIRST_PART = { reply: 'first part', toolCalls: [{ id: 'call_1', name: 'read', arguments: { path: 'absent.txt' } }] };
const scenarios = [
  { id: 'cycle1-route-object', options: { ...CYCLE, preset: { ...STUB, effort: 'low' }, config: { presets: [] } }, call: { idleTimeoutMs: 120000 } },
  { id: 'preset-name', options: { ...CYCLE, preset: 'p1', config: { presets: [{ id: 'p1', ...STUB }] } } },
  { id: 'call-preset-wins', options: { ...CYCLE, preset: 'unused', config: { presets: [{ id: 'p1', ...STUB }] } }, call: { preset: 'p1' } },
  { id: 'preset-name-unknown', options: { ...CYCLE, preset: 'nope', config: { presets: [{ id: 'p1', ...STUB }] } } },
  { id: 'route-unresolved', options: { ...CYCLE, config: { presets: [] } } },
  { id: 'maintainer-route', options: { ...CYCLE, config: { presets: [], agents: { maintainer: { ...STUB, effort: 'high', fast: true } } } } },
  { id: 'maintainer-incomplete-falls-to-default', options: { ...CYCLE, config: { presets: [], agents: { maintainer: { provider: 'stub', model: ' ' } }, default: { ...STUB } } } },
  { id: 'main-default-route', options: { ...CYCLE, config: { presets: [], default: { ...STUB, effort: 'medium' } } } },
  { id: 'maintainer-disabled', options: { ...CYCLE, config: { presets: [], disabledAgents: ['maintainer'], agents: { maintainer: { ...STUB } }, default: { ...STUB } } } },
  { id: 'route-context-choice', options: { ...CYCLE, preset: { ...STUB, contextPercent: 40, contextTokens: 64000 }, config: { presets: [] } } },
  { id: 'provider-fails', options: { ...CYCLE, preset: { ...STUB }, config: { presets: [] } }, stub: { fail: 'provider exploded' } },
  { id: 'long-reply-brief', options: { ...CYCLE, brief: true, preset: { ...STUB }, config: { presets: [] } }, stub: { reply: 'x'.repeat(13000) } },
  { id: 'long-reply-not-brief', options: { ...CYCLE, preset: { ...STUB }, config: { presets: [] } }, stub: { reply: 'x'.repeat(13000) } },
  { id: 'empty-reply', options: { ...CYCLE, preset: { ...STUB }, config: { presets: [] } }, stub: { reply: '' } },
  { id: 'call-cwd-wins', options: { ...CYCLE, cwd: '/opt/opts', preset: { ...STUB }, config: { presets: [] } }, call: { cwd: '/opt/call' } },
  { id: 'opts-cwd', options: { ...CYCLE, cwd: '/opt/opts', preset: { ...STUB }, config: { presets: [] } } },
  { id: 'parent-sessions', options: { ...CYCLE, parentSessionId: 'sess_parent', preset: { ...STUB }, config: { presets: [] } } },
  { id: 'owner-null', options: { ...CYCLE, parentSessionId: 'sess_parent', ownerSessionId: null, preset: { ...STUB }, config: { presets: [] } } },
  { id: 'owner-given', options: { ...CYCLE, ownerSessionId: 'sess_owner', sourceName: 'opts-name', preset: { ...STUB }, config: { presets: [] } }, call: { sourceName: 'call-name' } },
  { id: 'explore-route', options: { agent: 'explore-agent', taskType: 'maintenance', config: { presets: [], agents: { explore: { ...STUB, effort: 'low' } }, default: { provider: 'other', model: 'm' } } } },
  { id: 'explore-disabled', options: { agent: 'explore-agent', config: { presets: [], disabledAgents: ['explore'], agents: { explore: { ...STUB } } } } },
  { id: 'title-agent-route', options: { agent: 'title-agent', config: { presets: [], agents: { maintainer: { ...STUB } } } } },
  { id: 'unknown-agent-without-preset', options: { agent: 'nobody', config: { presets: [], default: { ...STUB } } } },
  { id: 'public-agent', options: { agent: 'worker', preset: { ...STUB }, config: { presets: [] }, brief: false } },
  { id: 'a-watchdog-stop-throws-even-with-partial-text', options: { agent: 'worker', preset: { ...STUB }, config: { presets: [] }, brief: false }, stub: [FIRST_PART, { streamThenHang: true }], call: { idleTimeoutMs: 1200 } },
  { id: 'empty-prompt', options: { ...CYCLE, preset: { ...STUB }, config: { presets: [] } }, call: { prompt: '' } },
  { id: 'admission-refused', options: { ...CYCLE, preset: { ...STUB }, config: { presets: [] } }, admissionFails: 'admission closed' },
  { id: 'parent-aborts-mid-ask', options: { ...CYCLE, preset: { ...STUB }, config: { presets: [] } }, stub: { hang: true }, abortAfterMs: 300 },
  { id: 'salvage-keeps-the-text-of-this-run', options: { agent: 'worker', preset: { ...STUB }, config: { presets: [] }, brief: false }, stub: [FIRST_PART, { hang: true }], abortAfterMs: 1500, salvage: true },
  { id: 'a-plain-abort-discards-the-text', options: { agent: 'worker', preset: { ...STUB }, config: { presets: [] }, brief: false }, stub: [FIRST_PART, { hang: true }], abortAfterMs: 1500 },
  { id: 'salvage-with-nothing-written', options: { ...CYCLE, preset: { ...STUB }, config: { presets: [] } }, stub: { hang: true }, abortAfterMs: 300, salvage: true },
  { id: 'watchdog-stops-a-silent-ask', options: { ...CYCLE, preset: { ...STUB }, config: { presets: [] } }, stub: { streamThenHang: true }, call: { idleTimeoutMs: 1200 } },];

const recorded = [];
for (const scenario of scenarios) {
  if (process.env.ONLY && !process.env.ONLY.split(',').includes(scenario.id)) continue;
  console.log('scenario', scenario.id);
  recorded.push(await run(scenario));
}
if (process.env.ONLY) {
  console.log(JSON.stringify(recorded, null, 1));
  process.exit(0);
}

// The inline host: the id checks, the run table and the abort-all, over a dispatcher stub.
const host = [];
{
  const closed = { value: false };
  const calls = [];
  const inline = createInlineAgentDispatch({
    assertOpen: (signal) => {
      if (closed.value) throw new Error('session runtime host is closed');
      if (signal?.aborted) throw signal.reason ?? new Error('aborted');
    },
    agentGraph: async () => ({
      dispatch: {
        makeAgentDispatch: (options) => async (args) => {
          calls.push({ options, args: { ...args, parentSignal: Boolean(args.parentSignal) } });
          if (args.prompt === 'hang') await new Promise((_resolve, reject) => args.parentSignal.addEventListener('abort', () => reject(args.parentSignal.reason), { once: true }));
          return `answer:${args.prompt}`;
        },
      },
    }),
    prepareAgentProviders: async () => {
      calls.push({ prepared: true });
    },
  });
  const attempt = async (id, payload, signal) => {
    const input = { payload, signalAborted: signal?.aborted === true };
    try {
      return { input, ok: await inline.agentDispatch(payload, { signal }) };
    } catch (error) {
      return { input, error: error?.message ?? String(error) };
    }
  };
  host.push({ id: 'no-dispatch-id', outcome: await attempt('', { agent: 'cycle1-agent', params: { prompt: 'p' } }) });
  host.push({ id: 'plain', outcome: await attempt('d1', { dispatchId: 'd1', agent: 'cycle1-agent', options: { taskType: 'maintenance', sourceType: 'memory-cycle', brief: false }, params: { prompt: 'p', preset: 'x', cwd: '/c', idleTimeoutMs: 5000 } }), calls: calls.splice(0) });
  host.push({ id: 'params-normalised', outcome: await attempt('d2', { dispatchId: 'd2', agent: 'cycle1-agent', params: { prompt: 7, preset: '', cwd: '', idleTimeoutMs: 'x' } }), calls: calls.splice(0) });
  host.push({ id: 'negative-idle-dropped', outcome: await attempt('d3', { dispatchId: 'd3', agent: 'cycle1-agent', params: { prompt: 'p', idleTimeoutMs: -1 } }), calls: calls.splice(0) });
  const first = inline.agentDispatch({ dispatchId: 'd4', agent: 'cycle1-agent', params: { prompt: 'hang' } }, {});
  first.catch(() => {});
  await new Promise((resolve) => setTimeout(resolve, 20));
  host.push({ id: 'duplicate-id', outcome: await attempt('d4', { dispatchId: 'd4', agent: 'cycle1-agent', params: { prompt: 'p' } }) });
  inline.abortAll('host closing');
  host.push({ id: 'abort-all', outcome: await first.then((ok) => ({ ok }), (error) => ({ error: error?.message ?? String(error) })) });
  const aborted = new AbortController();
  aborted.abort(new Error('caller gone'));
  host.push({ id: 'signal-already-aborted', outcome: await attempt('d5', { dispatchId: 'd5', agent: 'cycle1-agent', params: { prompt: 'p' } }, aborted.signal) });
  host.push({ id: 'run-table-cleared', outcome: await attempt('d4', { dispatchId: 'd4', agent: 'cycle1-agent', params: { prompt: 'again' } }), calls: calls.splice(0).slice(-2) });
  closed.value = true;
  host.push({ id: 'host-closed', outcome: await attempt('d6', { dispatchId: 'd6', agent: 'cycle1-agent', params: { prompt: 'p' } }) });
}

writeJson(join(stage, 'golden.json'), { hidden, dispatches: recorded, host });
writeSetManifest(stage, { set: 'agent-dispatch', recorder, command: `node ${recorder} --tree <tree>`, identityTree: tree });
commitStage(stage, finalDir);
rmSync(sandbox, { recursive: true, force: true });
// The product's index-lock retry timer keeps the loop alive.
process.exit(0);
