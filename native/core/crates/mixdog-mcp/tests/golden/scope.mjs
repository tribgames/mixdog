// Records, from today's Node product, what `setExtensionScope` (session-runtime/resource-api.mjs)
// saves and answers. Usage: node scope.mjs <repo-root> <out.json> (paths use the host's form).
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const [root, out] = process.argv.slice(2);
const load = (rel) => import(pathToFileURL(join(root, 'src', rel)).href);
const { createResourceApi } = await load('session-runtime/resource-api.mjs');

const p = (name) => join(tmpdir(), name);
const plugins = [
  { id: 'acme', name: 'Acme Tools', title: 'Acme' },
  { id: '', name: 'nameonly', title: 'Name Only' },
  { id: 7, name: 'numeric', title: 'N' },
  { id: 'other', name: 'Other', title: 'The Other' },
];
const base = {
  theme: 'dark',
  extensionScopes: {
    skills: { deploy: [p('a'), p('b')], 7: [p('seven')], build: [p('c')] },
    mcp: { gmail: [p('m')] },
    plugins: { acme: [p('x')] },
  },
};
const R = (...parts) => parts;
const cases = [
  ['skill to one project', base, 'skills', 'deploy', [p('z')]],
  ['skill to many projects unsorted', base, 'skills', 'new', [p('b'), p('a'), p('B')]],
  ['skill global by empty list', base, 'skills', 'deploy', []],
  ['skill global by null', base, 'skills', 'deploy', null],
  ['skill global when omitted', base, 'skills', 'deploy', undefined],
  ['skill single string', base, 'skills', 'solo', p('only')],
  ['skill duplicate roots', base, 'skills', 'dup', [p('a'), p('a') + '/', p('a') + '\\']],
  ['skill dotted roots', base, 'skills', 'dots', [p('a/./b/../c')]],
  ['skill blank roots dropped', base, 'skills', 'blank', ['', '  ', p('k')]],
  ['skill only blank roots', base, 'skills', 'deploy', ['', ' ']],
  ['skill non-string roots', base, 'skills', 'nonstr', [5, null, true, p('s')]],
  ['skill name padded', base, 'skills', '  deploy  ', [p('q')]],
  ['skill name numeric key goes first', base, 'skills', '3', [p('t')]],
  ['skill name numeric existing', base, 'skills', '7', []],
  ['skill kind padded', base, '  skills ', 'deploy', [p('q')]],
  ['kind unknown', base, 'hooks', 'deploy', [p('q')]],
  ['kind empty', base, '', 'deploy', [p('q')]],
  ['kind uppercase', base, 'Skills', 'deploy', [p('q')]],
  ['kind missing', base, undefined, 'deploy', [p('q')]],
  ['mcp refused', base, 'mcp', 'gmail', [p('q')]],
  ['mcp refused before the name check', base, 'mcp', '', [p('q')]],
  ['name empty', base, 'skills', '', [p('q')]],
  ['name blank', base, 'skills', '   ', [p('q')]],
  ['name missing', base, 'skills', undefined, [p('q')]],
  ['name null', base, 'skills', null, [p('q')]],
  ['plugin by id', base, 'plugins', 'acme', [p('y')]],
  ['plugin by name', base, 'plugins', 'Acme Tools', [p('y')]],
  ['plugin by title', base, 'plugins', 'Acme', [p('y')]],
  ['plugin by padded title', base, 'plugins', '  Acme ', [p('y')]],
  ['plugin with no id falls back to the name', base, 'plugins', 'nameonly', [p('y')]],
  ['plugin with a numeric id', base, 'plugins', 'numeric', [p('y')]],
  ['plugin global', base, 'plugins', 'acme', []],
  ['plugin new entry', base, 'plugins', 'The Other', [p('y')]],
  ['plugin unknown', base, 'plugins', 'ghost', [p('y')]],
  ['plugin lookup is case sensitive', base, 'plugins', 'ACME', [p('y')]],
  ['config without scopes', { theme: 'dark' }, 'skills', 'deploy', [p('q')]],
  ['config empty', {}, 'skills', 'deploy', [p('q')]],
  ['config scopes malformed', { extensionScopes: 'x' }, 'skills', 'deploy', [p('q')]],
  ['config scopes with unknown kind and empty lists', { extensionScopes: { hooks: { a: [p('a')] }, skills: { e: [], f: [p('f')] } } }, 'skills', 'deploy', [p('q')]],
  ['config scopes single string entry', { extensionScopes: { skills: { e: p('e') } } }, 'skills', 'deploy', [p('q')]],
  ['config scopes padded names', { extensionScopes: { skills: { ' pad ': [p('e')] } } }, 'skills', 'deploy', [p('q')]],
  ['removing the last entry keeps the empty kinds', { extensionScopes: { skills: { deploy: [p('a')] } } }, 'skills', 'deploy', null],
];

const results = [];
for (const [name, config, kind, target, projects] of cases) {
  const events = [];
  let saved = null;
  const deps = {
    getConfig: () => structuredClone(config),
    getCurrentCwd: () => root,
    hooks: {},
    saveConfigAndAdopt: (next) => {
      saved = structuredClone(next);
    },
    mcpStatus: () => ({ servers: [] }),
    skillsStatus: () => ({ skills: [] }),
    pluginsStatus: () => ({ plugins: structuredClone(plugins) }),
    connectConfiguredMcp: async () => {},
    invalidatePreSessionToolSurface: () => {},
    reloadFullConfig: () => {},
    invalidateSkills: () => {},
  };
  const api = createResourceApi(deps);
  let error = null;
  let answered = null;
  try {
    const result = await (projects === undefined ? api.setExtensionScope(kind, target) : api.setExtensionScope(kind, target, projects));
    answered = ['servers', 'skills', 'plugins'].find((key) => Array.isArray(result?.[key])) ?? null;
  } catch (e) {
    error = e.message;
  }
  results.push({ name, config, kind: kind ?? null, target: target ?? null, projects: projects === undefined ? 'omitted' : projects, plugins, saved, answered, error });
}
writeFileSync(out, `${JSON.stringify({ cwd: process.cwd(), cases: results })}\n`);
console.log(`recorded ${results.length} cases`);
process.exit(0);
