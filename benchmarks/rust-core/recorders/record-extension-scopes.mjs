#!/usr/bin/env node
// What the project scope of an extension decides, on real Node (`shared/extension-scopes.mjs`): the normalized `{ skills, mcp, plugins }`
// map a config holds (empty lists, unknown kinds and duplicate roots dropped, roots resolved and sorted), which projects an entry is
// limited to, whether a cwd is within a root, whether a skill (its own scope and its plugin's) or an MCP server (its own scope intersected
// with its plugin's) is visible from a cwd, and `withExtensionScope` replacing and clearing one entry. The inputs are the ones of
// runtime-core/extension-scopes.test.mjs.
//
// Paths are written under <BASE> (an absolute folder of the recorder's choosing, never created); every string of the output that holds it
// has it back as <BASE> and its separators as "/", so a replay on any platform names its own base.
//
//   node benchmarks/rust-core/recorders/record-extension-scopes.mjs --tree <exact export of b6f10295a with node_modules>
// Output: native/core/fixtures/extension-scopes/golden.json
import { join, resolve } from 'node:path';
import { recorderProvenance } from './lib/provenance.mjs';
import { FIXTURES_ROOT, commitStage, exactProductIdentity, importFrom, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } from './lib/common.mjs';

const NODE_COMMIT = 'b6f10295a2f698afc85332467192de28500bd146';
const recorder = 'benchmarks/rust-core/recorders/record-extension-scopes.mjs';
const tree = resolveTree(parseArgs());
const identity = exactProductIdentity(tree, NODE_COMMIT);
const scopesModule = await importFrom(tree, 'src/runtime/shared/extension-scopes.mjs');
const { normalizeExtensionScopes, extensionScopeProjects, cwdWithinProjects, skillAllowedForCwd, withExtensionScope } = scopesModule;
const { mcpServerAllowedForCwd } = await importFrom(tree, 'src/runtime/agent/orchestrator/runtime-core/extension-scopes.mjs');

const BASE = resolve('/recorder-base');
const decode = (value) => JSON.parse(JSON.stringify(value).replaceAll(JSON.stringify(BASE).slice(1, -1), '<BASE>').replaceAll('\\\\', '/'));
const A = '<BASE>/work/alpha';
const B = '<BASE>/work/beta';
const input = (value) => JSON.parse(JSON.stringify(value).replaceAll('<BASE>', JSON.stringify(BASE).slice(1, -1)));

const normalize = [
  { name: 'empty lists, unknown kinds and duplicate roots drop', scopes: { skills: { deploy: [A, `${A}/`, ''], empty: [] }, mcp: { unity: B }, bogus: { x: [A] } } },
  { name: 'nothing', scopes: {} },
  { name: 'roots sort and a single root is a list', scopes: { plugins: { unity: [B, A], one: A }, skills: { ' padded ': [A] } } },
  { name: 'not an object', scopes: 'x' },
].map((c) => ({ ...c, normalized: decode(normalizeExtensionScopes(input(c.scopes))) }));

const projectsCases = [
  { scopes: { skills: { deploy: [A], empty: [] } }, kind: 'skills', name: 'deploy' },
  { scopes: { skills: { deploy: [A], empty: [] } }, kind: 'skills', name: 'empty' },
  { scopes: { skills: { deploy: [A], empty: [] } }, kind: 'skills', name: 'unknown' },
].map((c) => ({ ...c, projects: decode(extensionScopeProjects(normalizeExtensionScopes(input(c.scopes)), c.kind, c.name)) }));

const within = [
  { cwd: A, projects: [A] },
  { cwd: `${A}/src/deep`, projects: [A] },
  { cwd: `${A}-other`, projects: [A] },
  { cwd: B, projects: [A] },
  { cwd: '', projects: [A] },
  { cwd: B, projects: [] },
].map((c) => ({ ...c, within: cwdWithinProjects(input(c.cwd), input(c.projects)) }));

const skillScopes = { skills: { bench: [A] }, plugins: { unity: [B] } };
const skill = [
  { skill: { name: 'bench' }, cwd: A },
  { skill: { name: 'bench' }, cwd: B },
  { skill: { name: 'free' }, cwd: B },
  { skill: { name: 'free', plugin: 'unity' }, cwd: A },
  { skill: { name: 'free', plugin: 'unity' }, cwd: B },
].map((c) => ({ ...c, scopes: skillScopes, allowed: skillAllowedForCwd(normalizeExtensionScopes(input(skillScopes)), c.skill, input(c.cwd)) }));

const mcpScopes = { mcp: { UnityMCP: [B], 'plugin-unity-editor': [A, B] }, plugins: { unity: [A] } };
const mcp = [
  { server: 'UnityMCP', cwd: A },
  { server: 'UnityMCP', cwd: B },
  { server: 'plugin-unity-editor', cwd: B, pluginId: 'unity' },
  { server: 'plugin-unity-editor', cwd: A, pluginId: 'unity' },
  { server: 'plugin-unity-tools', cwd: B },
  { server: 'demo', cwd: A },
].map((c) => ({ ...c, scopes: mcpScopes, allowed: mcpServerAllowedForCwd(normalizeExtensionScopes(input(mcpScopes)), c.server, input(c.cwd), c.pluginId ? { pluginId: c.pluginId } : undefined) }));

const withScope = [
  { name: 'one entry replaced, the others and the rest of the config kept', config: { other: 1, extensionScopes: { skills: { old: [A] } } }, kind: 'skills', entry: 'bench', projects: [B, A] },
  { name: 'an empty list clears the entry', config: { other: 1, extensionScopes: { skills: { bench: [A] } } }, kind: 'skills', entry: 'bench', projects: [] },
  { name: 'a plugin entry', config: {}, kind: 'plugins', entry: 'unity', projects: [A] },
].map((c) => ({ ...c, config: c.config, result: decode(withExtensionScope(input(c.config), c.kind, c.entry, input(c.projects))) }));

const finalOut = join(FIXTURES_ROOT, 'extension-scopes');
const stage = stageSet(finalOut);
writeJson(join(stage, 'golden.json'), { note: 'the project scope rules of real Node over the inputs of extension-scopes.test.mjs', normalize, projects: projectsCases, within, skill, mcp, withScope });
writeSetManifest(stage, {
  set: 'extension-scopes',
  recorder,
  command: `node ${recorder} --tree <exact export of ${NODE_COMMIT}>`,
  identity,
  extra: {
    ...recorderProvenance(import.meta.url),
    cases: normalize.length + projectsCases.length + within.length + skill.length + mcp.length + withScope.length,
    syntheticInputs: ['the scope maps, cwds, skills and servers: the inputs of runtime-core/extension-scopes.test.mjs, written under <BASE>'],
    keptWhole: 'per case: its input and the answer (the normalized map, the roots, the verdict, the config)',
    exclusions: {
      '<BASE> and path separators in answers': 'the recorder\'s base folder is written back as <BASE> and every backslash as "/", so a replay on any platform compares its own base',
      'a skill whose owner is {kind: "plugin", id}': 'the core\'s skill carries its plugin as one field (`plugin`); Node\'s two shapes of the same fact are not both an input to it',
      'withExtensionScope on kind "mcp" and on an unknown kind': 'the core refuses both before it writes (the settings call names MCP servers per project and checks the kind first), with the settings call\'s message, not withExtensionScope\'s',
    },
  },
});
commitStage(stage, finalOut);
console.log(`cases ok`);
process.exit(0);
