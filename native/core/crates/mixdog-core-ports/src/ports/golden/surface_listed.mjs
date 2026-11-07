// Records, from today's Node product, the `tools` list of the skills status: `skillsStatus().tools`
// of the real `createSkillsApi`, fed by the `getTools` of `wireSkills` (`boot/infrastructure.mjs`,
// an inline lambda of the boot module, copied here verbatim). Each case is a tool surface as the
// session header carries it: `tools`, `deferredToolCatalog`, `deferredLateToolCatalog`.
// Usage: node surface_listed.mjs <repo-root> <out.json>
// Every user location is pointed at temp folders BEFORE any Mixdog module loads.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const [root, out] = process.argv.slice(2, 4);
const scratch = mkdtempSync(join(tmpdir(), 'surface-listed-'));
for (const name of ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'MIXDOG_HOME', 'MIXDOG_DATA_DIR']) {
  process.env[name] = join(scratch, name.toLowerCase());
  mkdirSync(process.env[name], { recursive: true });
}

const t = (name, extra = {}) => ({ name, description: `${name} tool`, ...extra });
const cases = [
  { name: 'no surface', surface: null },
  { name: 'empty surface', surface: {} },
  { name: 'eager only', surface: { tools: [t('read'), t('grep'), t('edit')] } },
  { name: 'catalog only', surface: { deferredToolCatalog: [t('web_search'), t('web_fetch')] } },
  { name: 'late only', surface: { deferredLateToolCatalog: [t('office')] } },
  { name: 'all three, disjoint', surface: { tools: [t('read'), t('grep')], deferredToolCatalog: [t('web_search'), t('git')], deferredLateToolCatalog: [t('office'), t('media')] } },
  { name: 'a name in every list keeps its first place', surface: { tools: [t('read'), t('git')], deferredToolCatalog: [t('web_search'), t('read'), t('git')], deferredLateToolCatalog: [t('git'), t('office'), t('web_search')] } },
  { name: 'repeats inside one list', surface: { tools: [t('read'), t('grep'), t('read')], deferredToolCatalog: [t('a'), t('a'), t('b')] } },
  { name: 'catalog before late, eager last in the file', surface: { deferredLateToolCatalog: [t('z')], deferredToolCatalog: [t('y')], tools: [t('x')] } },
  { name: 'the deferred bookkeeping is not a list', surface: { tools: [t('read')], deferredCallableTools: ['web_search'], deferredDiscoveredTools: ['git'] } },
  { name: 'names that differ by case are different', surface: { tools: [t('Skill'), t('skill')] } },
];

const getTools = (surface) => () =>
  [
    ...new Map(
      [
        ...(surface?.tools || []),
        ...(surface?.deferredToolCatalog || []),
        ...(surface?.deferredLateToolCatalog || []),
      ].map((tool) => [tool.name, tool])
    ).values(),
  ];

const { createSkillsApi } = await import(pathToFileURL(join(root, 'src/session-runtime/skills-api.mjs')).href);
const recorded = cases.map((c) => {
  const api = createSkillsApi({
    contextMod: { collectSkillsCached: () => [], skillEnabledFlags: () => [] },
    getCwd: () => scratch,
    getTools: getTools(c.surface),
  });
  return { name: c.name, surface: c.surface, tools: api.skillsStatus().tools.map(({ name }) => name) };
});
rmSync(scratch, { recursive: true, force: true });
writeFileSync(out, `${JSON.stringify({ cases: recorded }, null, 2)}\n`);
