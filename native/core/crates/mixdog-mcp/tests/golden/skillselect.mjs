// Records, from today's Node product, which skills a user prompt explicitly selects: the leading
// `Skill: "name"` header (selectedSkillName), every inline `$name` outside Markdown code
// (skillMentionCandidates) and the skills both resolve to for a working directory
// (explicitSkillNames: only skills enabled and in scope, first-mention order, at most five).
// Prompts are strings or arrays of strings / content parts; the random texts are drawn from the
// characters that matter to the scanners, from a fixed seed.
// Usage: node skillselect.mjs <repo-root> <base-dir> <out.json>
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const [root, base, out] = process.argv.slice(2);
rmSync(base, { recursive: true, force: true });
process.env.MIXDOG_DATA_DIR = join(base, 'data');
process.env.MIXDOG_AGENT_TRACE_DISABLE = '1';
delete process.env.MIXDOG_DISABLE_SKILLS;
const load = (...parts) => import(pathToFileURL(join(root, 'src', ...parts)).href);
const { explicitSkillNames } = await load('runtime', 'agent', 'orchestrator', 'session', 'explicit-skills.mjs');
const { selectedSkillName } = await load('runtime', 'shared', 'skill-selection.mjs');
const { skillMentionCandidates } = await load('runtime', 'shared', 'skill-mentions.mjs');
const { collectPromptSkillsCached, invalidateSkillsCache } = await load('runtime', 'agent', 'orchestrator', 'context', 'collect.mjs');

const names = ['alpha', 'beta-two', 'pptx', 'path', 'home', 'a', 'x1', 'skill-1', 'skill-2', 'skill-3', 'skill-4', 'skill-5', 'skill-6', 'skill-7', 'a'.repeat(64)];
for (const name of names) {
  mkdirSync(join(base, 'data', 'skills', name), { recursive: true });
  writeFileSync(join(base, 'data', 'skills', name, 'SKILL.md'), `---\nname: ${name}\ndescription: Use when ${name}.\n---\n\n# ${name}\n`);
}
const cwd = join(base, 'proj');
mkdirSync(cwd, { recursive: true });
invalidateSkillsCache(join(base, 'data'));
const available = collectPromptSkillsCached(cwd).map((skill) => skill.name);

const ref = 'a'.repeat(64);
const prompts = [
  '',
  'plain prose',
  '$alpha',
  'use $alpha and $pptx then $alpha again',
  'Skill: "alpha"\n\nbody',
  'Skill: "alpha"\r\n\r\nbody',
  'Skill: "alpha"\n\r\nbody',
  'Skill: "alpha"\r\nbody',
  'Skill: "alpha"\nbody',
  'Skill: " alpha "\n\n',
  'Skill: "\\u0061lpha"\n\nx',
  'Skill: "al\\"pha"\n\nx',
  'Skill: "ghost"\n\n$beta-two',
  'Skill: ""\n\n$alpha',
  'Skill: "  "\n\n$alpha',
  'Skill: 5\n\n$alpha',
  'Skill: "\\ud800"\n\n$alpha',
  'Skill: "pptx"\n\n$pptx $alpha',
  ' Skill: "alpha"\n\nx',
  'not first\nSkill: "alpha"\n\nx',
  'Work on $path and $home',
  'Work on $PATH and $Home and $300',
  '$300 $a $x1',
  '($alpha) [$pptx] {$a} "$x1" \'$path\' `$home`',
  'a$alpha b$pptx\t$a\n$x1\u00a0$alpha\u3000$pptx\ufeff$a',
  '$alpha_x $alpha-x $alphaX $alpha. $alpha, $alpha로 $alpha한',
  '$alpha-',
  '$-alpha',
  `$${'a'.repeat(64)} $${'a'.repeat(65)} $${'a'.repeat(63)}`,
  '```\n$alpha\n```\n$pptx',
  '```\n$alpha\n$pptx',
  '~~~\n$alpha\n~~~\n$pptx',
  '````\n```\n$alpha\n````\n$pptx',
  '```js x\n$alpha\n```\n$pptx',
  '``` `x\n$alpha\n```\n$pptx',
  '   ```\n$alpha\n   ```\n$pptx',
  '    ```\n$alpha\n```\n$pptx',
  '```\n$alpha\n``` x\n$pptx\n```',
  '```\r\n$alpha\r\n```\r\n$pptx',
  '```\u2028\n$alpha\n```\n$pptx',
  '`$alpha` $pptx',
  '`` `$alpha` `` $pptx',
  '`$alpha $pptx',
  '`a` $alpha `b` $pptx',
  '``$alpha` $pptx``',
  '$skill-1 $skill-2 $skill-3 $skill-4 $skill-5 $skill-6 $skill-7',
  'Skill: "skill-7"\n\n$skill-1 $skill-2 $skill-3 $skill-4 $skill-5 $skill-6',
  '$unknown $alpha $ghost',
  ['$alpha'],
  [],
  ['Skill: "pptx"\n\nhi', '$alpha'],
  [{ type: 'text', text: 'Skill: "pptx"\n\nhi' }, { type: 'text', text: '$alpha' }],
  [{ type: 'text', text: '$alpha' }, { type: 'text', text: '$pptx', attachmentRef: ref }],
  [{ type: 'text', text: '$alpha', attachmentRef: 'short' }, { type: 'text', text: '$pptx', attachmentRef: ref.toUpperCase() }],
  [{ type: 'text', text: 'Skill: "alpha"\n\nx', attachmentRef: ref }, { type: 'text', text: '$pptx' }],
  [{ type: 'image', source: '$alpha' }, { type: 'text', text: '$pptx' }],
  [{ type: 'text' }, { type: 'text', text: 5 }, '$a'],
  [{ type: 'text', text: '$alpha' }, { type: 'text', text: '$alpha' }, { type: 'text', text: 'and $x1' }],
  [{ type: 'text', text: '`' }, { type: 'text', text: '$alpha`' }],
  [null, '$alpha'],
  [{ type: 'text', text: 'Skill: "alpha"\n\n' }],
];

let seed = 20240607;
const next = () => {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  return seed / 2 ** 32;
};
const pieces = ['$', '$', '$', 'alpha', 'pptx', 'a', 'x1', 'skill-1', 'path', 'A', '-', '_', '0', ' ', ' ', '\n', '\r', '\r\n', '\t', '(', '[', '{', '"', "'", '`', '`', '``', '```', '~~~', '~', '\u2028', '\u00a0', '\ufeff', '한', '.', 'Skill: "alpha"\n\n'];
for (let i = 0; i < 1500; i += 1) {
  let text = '';
  const length = 1 + Math.floor(next() * 14);
  for (let j = 0; j < length; j += 1) text += pieces[Math.floor(next() * pieces.length)];
  prompts.push(text);
}

const cases = prompts.map((prompt) => {
  const candidates = typeof prompt === 'string' ? skillMentionCandidates(prompt) : null;
  // A header naming a lone surrogate cannot be written as JSON text, nor be a skill's name.
  const header = selectedSkillName(prompt);
  const lone = typeof header === 'string' && /[\ud800-\udfff]/.test(header);
  return { prompt, candidates, header: lone ? null : header, loneSurrogateHeader: lone, names: explicitSkillNames(prompt, cwd) };
});
writeFileSync(out, JSON.stringify({ available, cases }, null, 1));
