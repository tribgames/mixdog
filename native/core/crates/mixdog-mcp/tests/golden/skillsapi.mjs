// Records, from today's Node product, what the skill methods of the runtime API
// (session-runtime/skills-api.mjs under resource-skills-api.mjs) answer, the files they leave in
// the skills folder, and the host effects they trigger. Skills sit under <base>/data/skills,
// recreated by the Rust replay; <base> is masked in the output. Only global skills are listed
// (the product's bundled skills depend on the install).
// Usage: node skillsapi.mjs <repo-root> <base-dir> <out.json>
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';

const [root, base, out] = process.argv.slice(2);
rmSync(base, { recursive: true, force: true });
const dataDir = join(base, 'data');
process.env.MIXDOG_DATA_DIR = dataDir;
delete process.env.MIXDOG_DISABLE_SKILLS;
mkdirSync(dataDir, { recursive: true });
writeFileSync(join(dataDir, 'mixdog-config.json'), JSON.stringify({ defaultsVersion: 2, agent: { skills: { disabled: ['beta'] } } }));
const load = (rel) => import(pathToFileURL(join(root, 'src', rel)).href);
const contextMod = await load('runtime/agent/orchestrator/context/collect.mjs');
const { createSkillsApi } = await load('session-runtime/skills-api.mjs');
const { createSkillsResourceApi } = await load('session-runtime/resource-skills-api.mjs');
const { createScopeDecorators } = await load('session-runtime/resource-scope-decorate.mjs');

const doc = (name, description, body, extra = '') => `---\nname: ${name}\ndescription: ${description}\n${extra}---\n\n${body}\n`;
const fixtures = {
  'alpha/SKILL.md': doc('alpha', 'Use when alpha.', '# Alpha\n\nRun it.', 'license: MIT # keep\n'),
  'beta/SKILL.md': doc('beta', 'Use when beta.', 'Beta body', 'when_to_use: Beta trigger\n'),
  'gamma/SKILL.md': doc('gamma', 'Use when gamma.', 'Gamma body'),
  'wrongname/SKILL.md': doc('other-name', 'Folder differs.', 'x'),
  'emptied/SKILL.md': '',
};
for (const [rel, text] of Object.entries(fixtures)) {
  mkdirSync(dirname(join(dataDir, 'skills', rel)), { recursive: true });
  writeFileSync(join(dataDir, 'skills', rel), text);
}
const proj1 = join(base, 'proj1');
const proj2 = join(base, 'proj2');
mkdirSync(join(proj1, 'sub'), { recursive: true });
mkdirSync(proj2, { recursive: true });
writeFileSync(join(base, 'afile'), 'x');
const cwd = join(proj1, 'sub');

const config = { extensionScopes: { skills: { gamma: [proj1] } } };
let disabled = ['beta'];
let events = [];
let disabledWrites = [];
const skillsApi = createSkillsApi({ contextMod, getCwd: () => cwd, getTools: () => [{ name: 'read' }, { name: 'bash' }] });
const decorate = createScopeDecorators({ getConfig: () => config, getCurrentCwd: () => cwd });
const ownOnly = (status) => {
  const skills = status.skills.filter((s) => s.source === 'global');
  return { ...status, count: skills.length, skills };
};
const api = createSkillsResourceApi({
  deps: {
    ...skillsApi,
    skillsStatus: (o) => ownOnly(skillsApi.skillsStatus(o)),
    getDisabledSkills: () => ({ disabled: [...disabled] }),
    setDisabledSkills(names) {
      disabled = [...new Set(names.map((n) => String(n).trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b));
      disabledWrites.push([...disabled]);
      return { disabled: [...disabled] };
    },
    flushSkillsSave: async () => events.push('flushSkills'),
    invalidateSkills: () => events.push('invalidateSkills'),
  },
  sync: { announce: async (kind, opts) => events.push(`announce:${kind}${opts?.invalidate === false ? ':keep' : ''}`) },
  decorate: { skills: (s, c) => decorate.skills(s, c) },
});
const realInvalidate = skillsApi.invalidateSkills;

const maskText = (text) => text.split(JSON.stringify(base).slice(1, -1)).join('<BASE>');
const mask = (value) => JSON.parse(maskText(JSON.stringify(value ?? null)));
const tree = (dir) => {
  const files = {};
  const walk = (d) => {
    for (const name of readdirSync(d).sort()) {
      const path = join(d, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (!/\.mixdog-tmp-|\.lock$/.test(name)) files[relative(dataDir, path).replace(/\\/g, '/')] = maskText(readFileSync(path, 'utf8'));
    }
  };
  walk(dir);
  return files;
};
const statSafe = (path) => statSync(path, { throwIfNoEntry: false });
const steps = [];
const step = async (name, method, params, fn) => {
  events = [];
  disabledWrites = [];
  let result = null;
  let error = null;
  try {
    result = await fn();
  } catch (e) {
    error = e.message;
  }
  void realInvalidate;
  steps.push({
    name,
    method,
    params: mask(params),
    result: mask(result),
    error: error === null ? null : maskText(error),
    events,
    disabledWrites,
    disabled: [...disabled],
    files: {
      ...tree(join(dataDir, 'skills')),
      // The override file is named by a hash of the skill's path, which differs per run.
      overrides: statSafe(join(dataDir, 'skill-tool-dependencies')) ? Object.values(tree(join(dataDir, 'skill-tool-dependencies'))).sort() : [],
    },
  });
};
const P = (o) => JSON.parse(JSON.stringify(o).split('<BASE>').join(JSON.stringify(base).slice(1, -1)));
const status = (name, options) => step(name, 'skills/skillsStatus', options ?? {}, () => api.skillsStatus(options));
const content = (name, skill) => step(name, 'skills/skillContent', { name: skill }, () => api.skillContent(skill));
const add = (name, input) => step(name, 'skills/addSkill', { input }, () => api.addSkill(input));
const save = (name, input) => step(name, 'skills/saveSkill', { input }, () => api.saveSkill(input));
const remove = (name, input) => step(name, 'skills/removeSkill', { input }, () => api.removeSkill(input));

await status('status of the fixtures');
await status('status for another folder', { cwd: proj2 });
await status('status with a relative folder', { cwd: 'rel/dir' });
await status('status with a file as folder', { cwd: join(base, 'afile') });
await status('status with an empty folder text', { cwd: '' });
await content('content of alpha', 'alpha');
await content('content of a disabled skill', 'beta');
await content('content with spaces around the name', '  gamma ');
await content('content of nothing', '');
await content('content of a ghost', 'ghost');
await step('disabled list', 'skills/getDisabledSkills', {}, () => ({ disabled: [...disabled] }));
await add('add a skill', { name: 'new-one', description: ' A new skill ', whenToUse: 'when new', instructions: 'Do the new thing.' });
await add('add the same again', { name: 'new-one', description: 'x', instructions: 'y' });
await add('add with defaults', { name: 'plain', description: 'Plain skill' });
await add('add with tool dependencies', { name: 'with-deps', description: 'Has deps', body: 'B', toolDependencies: [{ type: 'tool', value: 'read' }, { type: 'mcp', value: 'srv' }] });
await add('add with bad dependencies', { name: 'bad-deps', description: 'x', toolDependencies: 'nope' });
await add('add with a bad name', { name: 'Bad Name', description: 'x' });
await add('add without a description', { name: 'nodesc' });
await add('add with a long trigger', { name: 'longwhen', description: 'x', whenToUse: 'w'.repeat(1025) });
await add('add with a very long description', { name: 'long-desc', description: 'word '.repeat(60), instructions: 'z' });
await add('add over an empty SKILL.md', { name: 'emptied', description: 'was empty', instructions: 'fresh' });
await save('save an unchanged skill', { originalName: 'alpha', name: 'alpha', description: 'Use when alpha.', whenToUse: '', instructions: '# Alpha\n\nRun it.' });
await save('save a new description', { originalName: 'alpha', name: 'alpha', description: 'Alpha, changed.', whenToUse: 'on alpha', instructions: '# Alpha\n\nChanged.' });
await step('disable new-one', 'skills/setDisabledSkills', { names: ['new-one', ' beta', 'beta'] }, () => api.setDisabledSkills(['new-one', ' beta', 'beta']));
await save('rename a disabled skill', { originalName: 'new-one', name: 'renamed-one', description: 'Renamed', whenToUse: '', instructions: 'Body kept.' });
await save('rename onto an existing skill', { originalName: 'plain', name: 'alpha', description: 'x', instructions: 'y' });
await save('rename onto an existing folder', { originalName: 'plain', name: 'wrongname', description: 'x', instructions: 'y' });
await save('save a missing skill', { originalName: 'ghost', name: 'ghost', description: 'x', instructions: 'y' });
await save('save a skill whose folder differs', { originalName: 'other-name', name: 'other-name', description: 'x', instructions: 'y' });
await save('save dependencies only', { originalName: 'with-deps', dependenciesOnly: true, toolDependencies: [{ type: 'tool', value: 'write' }] });
await save('save dependencies only without dependencies', { originalName: 'with-deps', dependenciesOnly: true });
await save('clear dependencies', { originalName: 'with-deps', dependenciesOnly: true, toolDependencies: null });
await save('rename keeping a dependency override', { originalName: 'with-deps', name: 'with-deps2', description: 'Has deps', instructions: 'B', toolDependencies: [{ type: 'tool', value: 'bash' }] });
await save('save without instructions', { originalName: 'alpha', name: 'alpha', description: 'Alpha, changed again.', instructions: '' });
await save('save with a bad original name', { originalName: 'Bad', name: 'x', description: 'y' });
await remove('remove an own skill', { name: 'renamed-one' });
await remove('remove a skill that is disabled', { name: 'beta' });
await remove('remove a ghost', { name: 'ghost' });
await remove('remove with a bad name', { name: '' });
await remove('remove a skill whose folder differs', { name: 'other-name' });
await step('disable by names', 'skills/setDisabledSkills', { names: ['b', ' a ', 'b', ''] }, () => api.setDisabledSkills(['b', ' a ', 'b', '']));
await step('reload', 'skills/reloadSkills', {}, () => api.reloadSkills());
void P;
writeFileSync(out, JSON.stringify({ base, fixtures, steps }, null, 1));
