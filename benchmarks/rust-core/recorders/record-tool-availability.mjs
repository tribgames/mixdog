// Records Node's `stageToolAvailability` (`runtime-core/tool-availability.mjs`): a live session's
// settings-gated tools brought to the live gate list without touching its prefix. Each case holds
// the session before, the live gates, the definitions `toolDefinitionsFor` can supply, the result
// and the session after (clock fixed). The Rust `stage_tool_availability` must give the same.
//
//   node benchmarks/rust-core/recorders/record-tool-availability.mjs --tree <dir with node_modules>
//
// Output: native/core/fixtures/tool-availability/golden.json.
import { mkdtempSync } from 'node:fs';
import { recorderProvenance } from './lib/provenance.mjs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// Import-time sweeps delete real user data: every user dir is a fresh temp dir first.
const sandbox = mkdtempSync(join(tmpdir(), 'tool-availability-'));
for (const key of ['MIXDOG_DATA_DIR', 'MIXDOG_HOME', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA']) process.env[key] = sandbox;
process.env.MIXDOG_SKIP_USER_DATA_BACKUP = '1';
process.env.TZ = 'UTC';
const NOW = 1_700_000_000_000;
Date.now = () => NOW;
const { FIXTURES_ROOT, commitStage, importFrom, nodeTreeIdentity, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } = await import('./lib/common.mjs');

const { nodeRealTool, writeJsonCompact } = await import('./lib/tool-definitions.mjs');
// --patch <file>[,<file>…]: the tree is the reference commit with those Node changes applied; the manifest names them.
const BASE_COMMIT = 'b6f10295a2f698afc85332467192de28500bd146';
const args = parseArgs();
const tree = resolveTree(args);
const patched = args.get('patch');
const finalDir = join(FIXTURES_ROOT, 'tool-availability');
const stage = stageSet(finalDir);
const recorder = 'benchmarks/rust-core/recorders/record-tool-availability.mjs';
const { stageToolAvailability } = await importFrom(tree, 'src/runtime/agent/orchestrator/runtime-core/tool-availability.mjs');

// The gated tools are the product's definitions.
const real = await nodeRealTool(tree);
const doc = (name) => real(name);
const session = (extra = {}) => ({
  id: 'sess_a',
  tools: [doc('read'), doc('shell'), doc('web_search')],
  deferredToolCatalog: [doc('read'), doc('shell'), doc('web_search'), doc('memory'), doc('git')],
  deferredCallableTools: ['read', 'shell', 'web_search'],
  callerDisallowedTools: ['get_goal'],
  disallowedTools: ['get_goal'],
  ...extra,
});
const ALL = ['web_search', 'web_fetch', 'memory', 'recall', 'git', 'github', 'browser', 'office', 'media', 'tidy', 'explore'].map((name) => doc(name));

const CASES = [
  ['no gate moved', session({ disallowedTools: ['get_goal', 'memory'] }), ['memory']],
  ['a gate closes on a tool the session holds', session(), ['web_search']],
  ['a gate closes on a tool the session never knew', session(), ['browser']],
  ['a gate opens on a tool in the catalog', session({ disallowedTools: ['get_goal', 'memory'] }), []],
  ['a gate opens on a tool the session never held: its definition joins the late catalog', session({ disallowedTools: ['get_goal', 'office'] }), []],
  ['a gate opens on a tool nothing can define', session({ disallowedTools: ['get_goal', 'media'] }), [], []],
  ['a caller denial is not a gate', session({ disallowedTools: ['get_goal', 'memory'], callerDisallowedTools: ['get_goal', 'memory'] }), []],
  ['react opens in a bot home chat only', session({ id: 'sess_home_lead', disallowedTools: ['get_goal', 'react'] }), []],
  ['react stays denied in a coding session', session({ disallowedTools: ['get_goal', 'react'] }), []],
  ['an allowlist keeps an opened tool invisible', session({ disallowedTools: ['get_goal', 'memory'], schemaAllowedTools: ['read', 'Shell'] }), []],
  ['a delegated worker is not folded', session({ owner: 'agent', disallowedTools: ['get_goal', 'memory'] }), []],
  ['names that are no gate are ignored and repeats count once', session(), ['read', 'web_search', 'web_search', 'nothing']],
  ['one gate closes while another opens, over a pending delta', session({ disallowedTools: ['get_goal', 'memory'], pendingDeferredToolDelta: { revision: 3, added: [{ name: 'web_search', description: 'late' }], removed: ['git'] }, deferredToolDeltaRevision: 3 }), ['web_search']],
  ['a late catalog tool is known', session({ disallowedTools: ['get_goal', 'tidy'], deferredLateToolCatalog: [doc('tidy')] }), []],
  ['repeats in the denial list', session({ disallowedTools: ['get_goal', 'memory', 'memory', 'web_search'] }), ['web_search']],
  ['a session without a tool list', { id: 'sess_none', disallowedTools: ['memory'] }, []],
];

const cases = CASES.map(([name, before, featureDenied, defs = ALL]) => {
  const live = structuredClone(before);
  let asked = null;
  const result = stageToolAvailability(live, featureDenied, (names) => {
    asked = names;
    return defs.filter((tool) => names.includes(tool.name));
  });
  return { name, before, featureDenied, definitions: defs, asked, result, after: live };
});
await writeJsonCompact(tree, join(stage, 'golden.json'), { now: NOW, cases });
writeSetManifest(stage, { set: 'tool-availability', recorder, command: 'node ' + recorder + ' --tree <tree>' + (patched ? ` --patch ${patched}` : ''), ...(patched ? { identity: nodeTreeIdentity(args, tree, BASE_COMMIT) } : { identityTree: tree }), extra: { ...recorderProvenance(import.meta.url) } });
commitStage(stage, finalDir);
