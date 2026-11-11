#!/usr/bin/env node
// Records Node's extension scopes for the k1 UNTESTED extension-scopes.test.mjs (gaps-rest.md section 3, mixdog-mcp
// `scopes.rs`). Every input of the test goes through Node's real `normalizeExtensionScopes`, `extensionScopeProjects`,
// `cwdWithinProjects`, `skillAllowedForCwd` and `withExtensionScope`; the inputs are recorded as built (the roots are
// this machine's `path.resolve` of the test's paths), with each whole answer.
//
//   node benchmarks/rust-core/recorders/record-extension-scopes-cases.mjs --tree <exact export of b6f10295a with node_modules>
//
// Writes native/core/fixtures/extension-scopes-cases/{golden.json,MANIFEST.json}.
import { join, resolve } from 'node:path';

import { FIXTURES_ROOT, commitStage, exactProductIdentity, importFrom, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } from './lib/common.mjs';
import { recorderProvenance } from './lib/provenance.mjs';

const NODE_COMMIT = 'b6f10295a2f698afc85332467192de28500bd146';
const RECORDER = 'benchmarks/rust-core/recorders/record-extension-scopes-cases.mjs';
const TEST = 'src/runtime/agent/orchestrator/runtime-core/extension-scopes.test.mjs';

const args = parseArgs();
const tree = resolveTree(args);
const identity = exactProductIdentity(tree, NODE_COMMIT);
const { normalizeExtensionScopes, extensionScopeProjects, cwdWithinProjects, skillAllowedForCwd, withExtensionScope } = await importFrom(
  tree,
  'src/runtime/agent/orchestrator/runtime-core/extension-scopes.mjs'
);

const A = resolve('/work/alpha');
const B = resolve('/work/beta');
const errorOf = (fn) => {
  try {
    fn();
    return null;
  } catch (error) {
    return error.message;
  }
};
const cases = [];

{
  const input = { skills: { deploy: [A, `${A}/`, ''], empty: [] }, mcp: { unity: B }, bogus: { x: [A] } };
  const scopes = normalizeExtensionScopes(input);
  const lookups = [['skills', 'empty'], ['skills', 'unknown'], ['skills', 'deploy'], ['mcp', 'unity']].map(([kind, name]) => ({
    kind,
    name,
    projects: extensionScopeProjects(scopes, kind, name),
  }));
  cases.push({ case: 'normalize drops empty lists, unknown kinds, and duplicate roots', kind: 'normalize', input, recorded: { scopes, lookups } });
}
{
  const checks = [
    [A, [A]],
    [join(A, 'src', 'deep'), [A]],
    [`${A}-other`, [A]],
    [B, [A]],
    ['', [A]],
    [B, []],
  ].map(([cwd, roots]) => ({ cwd, roots, within: cwdWithinProjects(cwd, roots) }));
  cases.push({ case: 'cwd matches a root itself or any directory below it', kind: 'within', recorded: { checks } });
}
{
  const config = { skills: { bench: [A] }, plugins: { unity: [B] } };
  const scopes = normalizeExtensionScopes(config);
  // The test's `owner: { kind: 'plugin', id }` is the skill's plugin; the core's skill carries it as `plugin`.
  const checks = [
    [{ name: 'bench' }, A],
    [{ name: 'bench' }, B],
    [{ name: 'free' }, B],
    [{ name: 'free', plugin: 'unity' }, A],
    [{ name: 'free', owner: { kind: 'plugin', id: 'unity' } }, B],
  ].map(([skill, cwd]) => ({ skill, plugin: skill.plugin ?? (skill.owner?.kind === 'plugin' ? skill.owner.id : null), cwd, allowed: skillAllowedForCwd(scopes, skill, cwd) }));
  cases.push({ case: 'skill scope and owning plugin scope both gate visibility', kind: 'skills', config, recorded: { checks } });
}
{
  const config = { other: 1, extensionScopes: { mcp: { UnityMCP: [A] } } };
  const scoped = withExtensionScope(config, 'skills', 'bench', [B, A]);
  const steps = [
    { from: 'config', kind: 'skills', name: 'bench', projects: [B, A], result: scoped },
    { from: 'scoped', kind: 'mcp', name: 'UnityMCP', projects: [], result: withExtensionScope(scoped, 'mcp', 'UnityMCP', []) },
  ];
  cases.push({
    case: 'withExtensionScope replaces one entry and clears it with an empty list',
    kind: 'set',
    config,
    recorded: { steps },
  });
  cases.push({
    case: 'withExtensionScope replaces one entry and clears it with an empty list: unknown kind',
    kind: 'unknownKind',
    recorded: { error: errorOf(() => withExtensionScope(config, 'agents', 'x', [A])) },
  });
}

const excluded = {
  'withExtensionScope replaces one entry and clears it with an empty list: unknown kind':
    'DIFFERENCE: Node refuses "agents" with "unknown extension scope kind: agents"; the core (plan_extension_scope) ' +
    'answers "extension scope kind must be one of skills, mcp, plugins"',
  'MCP tools filter by server scope intersected with the owning plugin scope':
    'GAP (gaps-rest.md section 2): the MCP tool filter by owner metadata is a listed gap, not part of this replay',
  'a live MCP registry is filtered per session cwd, cascading the plugin scope from owner metadata':
    'GAP (gaps-rest.md section 2): the live registry cascade is a listed gap, not part of this replay',
};

const finalDir = join(FIXTURES_ROOT, 'extension-scopes-cases');
const stage = stageSet(finalDir);
writeJson(join(stage, 'golden.json'), { note: `Node's extension scopes at ${NODE_COMMIT}, per case of ${RECORDER}`, test: TEST, cases });
writeSetManifest(stage, {
  set: 'extension-scopes-cases',
  recorder: RECORDER,
  command: `node ${RECORDER} --tree <exact export of ${NODE_COMMIT}>`,
  identity,
  extra: {
    ...recorderProvenance(import.meta.url),
    compared:
      "normalize: the whole normalized scopes and each lookup's roots; within: each answer; skills: each answer; set: each step's whole config and the unknown-kind error",
    excluded,
  },
});
commitStage(stage, finalDir);
console.log(`extension-scopes-cases: ${cases.length} case(s), ${Object.keys(excluded).length} named exclusion(s)`);
process.exit(0);
