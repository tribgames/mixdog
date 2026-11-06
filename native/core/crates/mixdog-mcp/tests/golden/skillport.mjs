// Records, from today's Node product, what the Skill tool's lookup answers for global skills:
// the refusal text (skillLoadRefusal) or, when nothing refuses, the loaded resource
// (loadSkillResource: body, directory, source). Skills sit under <base>/data/skills, recreated by
// the Rust replay; <base> is masked in the output.
// Usage: node skillport.mjs <repo-root> <base-dir> <out.json>
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const [root, base, out] = process.argv.slice(2);
rmSync(base, { recursive: true, force: true });
process.env.MIXDOG_DATA_DIR = join(base, 'data');
delete process.env.MIXDOG_DISABLE_SKILLS;
const ctx = await import(pathToFileURL(join(root, 'src', 'runtime', 'agent', 'orchestrator', 'context', 'collect.mjs')).href);

const doc = (name, description, body, extra = '') => `---\nname: ${name}\ndescription: ${description}\n${extra}---\n\n${body}\n`;
const fixtures = {
  'alpha/SKILL.md': doc('alpha', 'Use when alpha.', '# Alpha\n\nRun ${MIXDOG_SKILL_DIR}/run.sh'),
  'beta/SKILL.md': doc('beta', 'Use when beta.', 'Beta body'),
  'gamma/SKILL.md': doc('gamma', 'Use when gamma.', 'Gamma body'),
  'delta-folder/SKILL.md': doc('delta', 'Folder does not match.', 'Never listed'),
  'epsilon/SKILL.md': '---\nname: epsilon\n---\nno description\n',
  'zeta/SKILL.md': `\uFEFF---\r\nname: zeta\r\ndescription: Use when zeta.\r\n---\r\n\r\nZeta line one\r\nline two\r\n`,
  'Eta/SKILL.md': doc('Eta', 'Uppercase names are not valid.', 'x'),
};
for (const [rel, text] of Object.entries(fixtures)) {
  mkdirSync(dirname(join(base, 'data', 'skills', rel)), { recursive: true });
  writeFileSync(join(base, 'data', 'skills', rel), text);
}
const proj1 = join(base, 'proj1');
const proj2 = join(base, 'proj2');
mkdirSync(join(proj1, 'sub'), { recursive: true });
mkdirSync(proj2, { recursive: true });
const config = {
  skills: { disabled: [' Beta '] },
  extensionScopes: { skills: { gamma: [proj1] } },
};

const maskText = (text) => text.split(JSON.stringify(base).slice(1, -1)).join('<BASE>');
const mask = (value) => JSON.parse(maskText(JSON.stringify(value ?? null)));
const queries = [
  ['alpha', join(proj2)],
  ['ALPHA', proj2],
  ['  alpha  ', proj2],
  ['beta', proj2],
  ['BETA', proj2],
  ['gamma', join(proj1, 'sub')],
  ['gamma', proj1],
  ['gamma', proj2],
  ['delta', proj2],
  ['epsilon', proj2],
  ['zeta', proj2],
  ['Eta', proj2],
  ['ghost', proj2],
  ['', proj2],
];
const cases = queries.map(([name, cwd]) => {
  const refusal = ctx.skillLoadRefusal(name, cwd, config);
  const resource = refusal ? null : ctx.loadSkillResource(name, cwd);
  return {
    name,
    cwd,
    refusal,
    resource: resource && { content: resource.content, dir: resource.dir, source: resource.source },
  };
});
writeFileSync(out, JSON.stringify({ base, fixtures, config: mask(config), cases: mask(cases) }, null, 1));
