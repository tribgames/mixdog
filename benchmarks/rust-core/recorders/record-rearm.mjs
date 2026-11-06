#!/usr/bin/env node
// What a manual compaction re-arms for the model afterwards (session-ops.mjs `compact`):
// `rearmLateDeferredTools(session)` (runtime-core/tool-catalog.mjs) and
// `rearmPromptSettingsNotice(session)` (session/manager/prompt-settings.mjs), each over a stored
// session object. Rust `run_host::rearm` must return the same value and leave the session
// the same.
//
//   node benchmarks/rust-core/recorders/record-rearm.mjs [--tree <dir>]
//
// Output: native/core/fixtures/rearm/golden.json. `Date.now` is fixed (the delta stamps `updatedAt`).
process.env.TZ = 'UTC';
import { join } from 'node:path';
import { FIXTURES_ROOT, commitStage, importFrom, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } from './lib/common.mjs';

const NOW = 1_700_000_000_000;
Date.now = () => NOW;
const tree = resolveTree(parseArgs());
const finalDir = join(FIXTURES_ROOT, 'rearm');
const stage = stageSet(finalDir);
const recorder = 'benchmarks/rust-core/recorders/record-rearm.mjs';
const at = (path) => importFrom(tree, path);
const { rearmLateDeferredTools } = await at('src/runtime/agent/orchestrator/runtime-core/tool-catalog.mjs');
const { rearmPromptSettingsNotice } = await at('src/runtime/agent/orchestrator/session/manager/prompt-settings.mjs');

const tool = (name, extra = {}) => ({ name, description: `the ${name} tool`, ...extra });
const base = (extra = {}) => ({
  id: 'sess_1',
  tools: [tool('read'), tool('load_tool')],
  deferredAnnouncedTools: ['read', 'grep'],
  deferredMcpToolNames: ['mcp__srv__alpha', 'mcp__srv__beta'],
  deferredLateToolCatalog: [tool('mcp__srv__alpha'), tool('mcp__srv__beta')],
  mcpInstructionsAnnounced: ['srv'],
  mcpInstructionHashes: { srv: 'abc' },
  ...extra,
});
const TOOLS = [
  ['late MCP tools connected and never listed', base()],
  ['no session tools array', base({ tools: undefined })],
  ['a fixed full surface', base({ deferredProviderMode: 'full' })],
  ['a fixed manifest surface on the bridge is not fixed', base({ deferredProviderMode: 'manifest', toolExposureMode: 'bridge-v1' })],
  ['a prompt identity of a lead', base({ promptIdentity: { hash: 'h' } })],
  ['a prompt identity of a delegated agent', base({ promptIdentity: { hash: 'h' }, owner: 'agent' })],
  ['no announced list', base({ deferredAnnouncedTools: undefined })],
  ['a tool the boot manifest listed', base({ deferredAnnouncedTools: ['mcp__srv__alpha'] })],
  ['a tool already loaded', base({ tools: [tool('mcp__srv__beta')] })],
  ['a tool the session discovered', base({ deferredDiscoveredTools: ['mcp__srv__alpha'] })],
  ['a tool callable', base({ deferredCallableTools: 'mcp__srv__beta' })],
  ['an MCP tool no longer connected', base({ deferredMcpToolNames: ['mcp__srv__beta'] })],
  ['no connected snapshot', base({ deferredMcpToolNames: undefined })],
  ['a built-in tool the policy permits', base({ deferredLateToolCatalog: [tool('web_fetch')], deferredMcpToolNames: [] })],
  ['a built-in tool the session denies', base({ deferredLateToolCatalog: [tool('web_fetch')], disallowedTools: ['Web_Fetch'] })],
  ['a built-in tool outside the allowlist', base({ deferredLateToolCatalog: [tool('web_fetch')], schemaAllowedTools: ['read'] })],
  ['a bridge roster that the policy refuses', base({ toolExposureMode: 'bridge-v1', disallowedTools: ['mcp__srv__alpha'] })],
  ['a read-only bridge roster', base({ toolExposureMode: 'bridge-v1', deferredSurfaceMode: 'readonly', deferredLateToolCatalog: [tool('mcp__srv__alpha'), tool('mcp__srv__beta', { annotations: { readOnlyHint: true } })] })],
  ['an unnamed late tool', base({ deferredLateToolCatalog: [{ description: 'x' }, tool('  mcp__srv__alpha  ')] })],
  ['no late catalog', base({ deferredLateToolCatalog: undefined })],
  ['names sort by locale', base({ deferredMcpToolNames: ['mcp__b__x', 'mcp__B__y', 'mcp__a__z'], deferredLateToolCatalog: [tool('mcp__b__x'), tool('mcp__B__y'), tool('mcp__a__z')] })],
  ['a pending delta is merged', base({ deferredToolDeltaRevision: 4, pendingDeferredToolDelta: { version: 1, type: 'deferred_tools_delta', revision: 6, added: [{ name: 'mcp__srv__zeta', description: 'old' }], removed: ['mcp__srv__gone'], removedServers: { mcp__srv__gone: 'srv' } } })],
  ['a pending removal of a re-armed tool cancels', base({ pendingDeferredToolDelta: { version: 1, type: 'deferred_tools_delta', revision: 1, added: [], removed: ['mcp__srv__alpha'], removedServers: { mcp__srv__alpha: 'srv' } } })],
  ['a pending delta with a long description', base({ pendingDeferredToolDelta: { version: 1, type: 'deferred_tools_delta', revision: 1, added: [{ name: 'mcp__srv__zeta', description: `${'word '.repeat(30)}<tag>` }], removed: [] } })],
  ['nothing late', base({ deferredLateToolCatalog: [tool('read')] })],
];
const SETTINGS = [
  ['told and pending', { id: 's', promptSettingsTold: { a: 1 }, promptSettingsNotice: { revision: 2 } }],
  ['told only', { id: 's', promptSettingsTold: { a: 1 } }],
  ['pending only', { id: 's', promptSettingsNotice: { revision: 2 } }],
  ['neither', { id: 's' }],
  ['a lead thread folds its settings', { id: 's', promptIdentity: 'h', promptSettingsTold: { a: 1 } }],
  ['a delegated agent is told again', { id: 's', promptIdentity: 'h', owner: 'Agent', promptSettingsTold: { a: 1 } }],
  ['a recheck is replaced', { id: 's', promptSettingsRecheck: true, promptSettingsTold: { a: 1 } }],
  ['empty told is falsy but an object is truthy', { id: 's', promptSettingsTold: {} }],
  ['a null told', { id: 's', promptSettingsTold: null, promptSettingsNotice: null }],
];

const clone = (value) => JSON.parse(JSON.stringify(value));
const cases = [];
for (const [name, session] of TOOLS) {
  const given = clone(session);
  const run = clone(session);
  const returned = rearmLateDeferredTools(run);
  cases.push({ kind: 'tools', name, session: given, returned: returned ?? null, after: run });
}
for (const [name, session] of SETTINGS) {
  const given = clone(session);
  const run = clone(session);
  const returned = rearmPromptSettingsNotice(run);
  cases.push({ kind: 'settings', name, session: given, returned, after: run });
}
writeJson(join(stage, 'golden.json'), { now: NOW, cases });
writeSetManifest(stage, { set: 'rearm', recorder, command: 'node ' + recorder + ' --tree <tree>', identityTree: tree });
commitStage(stage, finalDir);
