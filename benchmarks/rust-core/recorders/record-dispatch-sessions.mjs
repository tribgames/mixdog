#!/usr/bin/env node
// Golden of what Node's `prepareAgentSession(spec)` (agent-runtime/session-builder.mjs, over the
// real `createSession` and `buildSessionRecord`) stamps on the session a hidden-role dispatch
// prepares (`native/core/fixtures/dispatch-sessions/golden.json`): for each spec the dispatch
// can build (agent-dispatch/session-prep.mjs; runtime spec from `resolveRuntimeSpec(preset,
// { lane: 'agent', agentId })`), the record's route, provenance and permission fields, or the
// error `createSession` throws. A stub provider is registered under `stub`; `missing` is not
// registered. Also recorded: `updateSessionStatus` on an open and on a closed session.
//
//   node <repo>/benchmarks/rust-core/recorders/record-dispatch-sessions.mjs --tree <tree>
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { FIXTURES_ROOT, parseArgs, resolveTree, writeJson, writeSetManifest } from './lib/common.mjs';

const repo = resolveTree(parseArgs());
const sandbox = mkdtempSync(join(tmpdir(), 'dispatch-sessions-'));
// Every user directory the product reads is a fresh temp directory before any Mixdog module loads.
for (const key of ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'MIXDOG_HOME', 'MIXDOG_DATA_DIR', 'MIXDOG_CONFIG_DIR', 'MIXDOG_RUNTIME_ROOT', 'MIXDOG_USER_DATA_BACKUP_ROOT', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR']) {
  mkdirSync(join(sandbox, key));
  process.env[key] = join(sandbox, key);
}
process.env.MIXDOG_AGENT_TRACE_DISABLE = '1';
delete process.env.MIXDOG_OWNER_SESSION_ID;
const at = (p) => import(pathToFileURL(join(repo, p)).href);

const { prepareAgentSession } = await at('src/runtime/agent/orchestrator/agent-runtime/session-builder.mjs');
const { resolveRuntimeSpec } = await at('src/runtime/agent/orchestrator/config-presets.mjs');
const manager = await at('src/runtime/agent/orchestrator/session/manager.mjs');
const { _withRegisteredProviderForTestAsync } = await at('src/runtime/agent/orchestrator/providers/registry.mjs');

// The stub answers each send from the case under way: a reply, a tool call, or a hang that ends
// with the request's signal.
let script = [];
let sends = 0;
let onSend = () => {};
const stub = {
  name: 'stub',
  contextWindow: 128000,
  async send(_messages, _model, _tools, opts) {
    const behaviour = script[Math.min(sends, script.length - 1)] ?? {};
    sends += 1;
    onSend(sends);
    if (behaviour.hang) {
      await new Promise((_resolve, reject) => {
        if (opts?.signal?.aborted) reject(opts.signal.reason);
        opts?.signal?.addEventListener('abort', () => reject(opts.signal.reason ?? new Error('aborted')), { once: true });
      });
    }
    return {
      content: behaviour.reply ?? '',
      toolCalls: behaviour.toolCalls ?? [],
      stopReason: behaviour.toolCalls ? 'tool_use' : 'end_turn',
      usage: { inputTokens: 10, outputTokens: 5 },
    };
  },
};
const STAMPED = [
  'provider', 'model', 'preset', 'presetName', 'effort', 'fast', 'autoEffort', 'modelParameters', 'contextPercent', 'contextTokens',
  'selectedContextWindow', 'agent', 'owner', 'sessionMode', 'callerDisallowedTools', 'mcpScopeId', 'scopeKey', 'lane', 'cwd',
  'taskType', 'agentTag', 'permission', 'toolPermission', 'schemaAllowedTools', 'sourceType', 'sourceName', 'permissionMode',
  'parentSessionId', 'ownerSessionId', 'visibility', 'clientHostPid', 'status', 'closed',
];

const CYCLE = { id: 'maint-cycle1-agent', name: 'MAINT CYCLE1-AGENT', type: 'agent', provider: 'stub', model: 'stub-model', tools: 'full', effort: 'low' };
// What agent-dispatch/session-prep.mjs hands `prepare` (the dispatch's spec, wp-agent PrepareSpec).
const cases = [
  { name: 'cycle1-hidden', spec: { agent: 'cycle1-agent', presetName: 'maint-cycle1-agent', preset: CYCLE, permission: 'read', cwd: null, sourceType: 'memory-cycle', parentSessionId: null, ownerSessionId: null, skipRoleReminder: true, schemaAllowedTools: [], taskType: 'maintenance' } },
  { name: 'explore-read-profile', spec: { agent: 'explore', presetName: 'explore', preset: { ...CYCLE, id: 'explore', name: 'Explore', effort: undefined }, permission: 'read', cwd: 'C:\\work\\repo', sourceName: 'search', parentSessionId: 'sess_parent', ownerSessionId: 'sess_parent', skipRoleReminder: true, schemaAllowedTools: ['code_graph', 'find', 'glob', 'list', 'grep', 'read'] } },
  { name: 'public-agent-full-schema', spec: { agent: 'reviewer', presetName: 'Main', preset: { provider: 'stub', model: 'stub-model', name: 'Main', fast: true, autoEffort: false, modelParameters: { temperature: 0.2 } }, permission: null, cwd: null, sourceType: 'scheduler', sourceName: 'nightly', parentSessionId: null, ownerSessionId: 'sess_owner', skipRoleReminder: false, taskType: 'routine' } },
  { name: 'context-choice', spec: { agent: 'cycle1-agent', presetName: 'p', preset: { provider: 'stub', model: 'stub-model', tools: 'readonly' }, permission: 'read', cwd: null, contextPercent: 47, contextTokens: 64000, selectedContextWindow: 64000, schemaAllowedTools: [] } },
  { name: 'unregistered-provider', spec: { agent: 'cycle1-agent', presetName: 'p', preset: { provider: 'missing', model: 'm' }, permission: 'read', cwd: null, schemaAllowedTools: [] } },
  { name: 'no-model', spec: { agent: 'cycle1-agent', presetName: 'p', preset: { provider: 'stub' }, permission: 'read', cwd: null, schemaAllowedTools: [] } },
  { name: 'no-provider', spec: { agent: 'cycle1-agent', presetName: 'p', preset: { model: 'm' }, permission: 'read', cwd: null, schemaAllowedTools: [] } },
];

const prepared = [];
const aborts = [];
let status = null;
await _withRegisteredProviderForTestAsync('stub', stub, async () => {
  for (const { name, spec } of cases) {
    const full = { ...spec, runtimeSpec: resolveRuntimeSpec(spec.preset, { lane: 'agent', agentId: spec.agent }) };
    try {
      const { session } = prepareAgentSession(full);
      const record = manager.getSession(session.id);
      prepared.push({
        name,
        spec,
        runtimeSpec: { lane: full.runtimeSpec.lane, scopeKey: full.runtimeSpec.scopeKey },
        stamped: Object.fromEntries(STAMPED.map((key) => [key, Object.hasOwn(record, key) ? record[key] ?? null : '<absent>'])),
      });
      await manager.closeSession(session.id, 'golden');
    } catch (error) {
      prepared.push({ name, spec, error: error?.message ?? String(error) });
    }
  }
  // updateSessionStatus: an open session takes the status; a closed one refuses it.
  const { session } = prepareAgentSession({ ...cases[0].spec, runtimeSpec: resolveRuntimeSpec(CYCLE, { lane: 'agent', agentId: 'cycle1-agent' }) });
  const open = await manager.updateSessionStatus(session.id, 'running');
  const runningStatus = manager.getSession(session.id)?.status ?? null;
  await manager.closeSession(session.id, 'ephemeral-done');
  const closed = await manager.updateSessionStatus(session.id, 'idle');
  status = { open, runningStatus, closed, afterClose: manager.getSession(session.id)?.status ?? null };

  // What `askSession` throws when the dispatch's signal (linked with `linkParentSignalToSession`)
  // aborts: before the ask, while a provider call is in flight, and between two provider calls
  // (after the first answered with a tool call, while the turn handles it).
  const abortCases = [
    { name: 'before-ask', when: 'before', script: [{ reply: 'never' }] },
    { name: 'during-call', when: 'send', script: [{ hang: true }] },
    { name: 'between-calls', when: 'tool', script: [{ toolCalls: [{ id: 'call_1', name: 'list', arguments: { path: '.' } }] }, { reply: 'after the tool' }] },
  ];
  for (const abortCase of abortCases) {
    const { session } = prepareAgentSession({
      ...cases[2].spec,
      schemaAllowedTools: ['list'],
      runtimeSpec: resolveRuntimeSpec(cases[2].spec.preset, { lane: 'agent', agentId: 'reviewer' }),
    });
    const controller = new AbortController();
    const abort = () => controller.abort(new Error('parent aborted'));
    manager.linkParentSignalToSession(session.id, controller.signal);
    script = abortCase.script;
    sends = 0;
    onSend = abortCase.when === 'send' ? () => setImmediate(abort) : () => {};
    if (abortCase.when === 'before') abort();
    const onToolCall = abortCase.when === 'tool' ? async () => abort() : undefined;
    let outcome;
    try {
      const result = await manager.askSession(session.id, 'go', null, onToolCall, sandbox, undefined, {});
      outcome = { ok: result?.content ?? null };
    } catch (error) {
      outcome = { error: String(error?.message ?? error).replace(session.id, '<session>') };
    }
    aborts.push({ name: abortCase.name, sends, ...outcome });
    await manager.closeSession(session.id, 'golden');
  }
});
await manager.flushPendingSessionSaves?.();
(await at('src/runtime/agent/orchestrator/session/store/session-writer-claim.mjs')).releaseHeldSessionWriters();
rmSync(sandbox, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });

const set = join(FIXTURES_ROOT, 'dispatch-sessions');
writeJson(join(set, 'golden.json'), { stampedKeys: STAMPED, prepared, status, aborts });
writeSetManifest(set, {
  set: 'dispatch-sessions',
  recorder: 'benchmarks/rust-core/recorders/record-dispatch-sessions.mjs',
  command: 'node <repo>/benchmarks/rust-core/recorders/record-dispatch-sessions.mjs --tree <tree>',
  identityTree: repo,
});
console.log(`recorded ${prepared.length} specs`);
process.exit(0);
