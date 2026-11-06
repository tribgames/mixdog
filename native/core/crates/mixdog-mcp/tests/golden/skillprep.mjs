// Records, from today's Node product, the messages explicit skill selection adds to a
// transcript (explicit-skills.mjs `prepareExplicitSkills`) and the skills it reports applied,
// for a Skill tool that answers each skill with a fixed result (an envelope with the skill body,
// a bare string, an error). Usage: node skillprep.mjs <repo-root> <base-dir> <out.json>
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const [root, base, out] = process.argv.slice(2);
rmSync(base, { recursive: true, force: true });
process.env.MIXDOG_DATA_DIR = join(base, 'data');
process.env.MIXDOG_AGENT_TRACE_DISABLE = '1';
delete process.env.MIXDOG_DISABLE_SKILLS;
const load = (...parts) => import(pathToFileURL(join(root, 'src', ...parts)).href);
const { prepareExplicitSkills } = await load('runtime', 'agent', 'orchestrator', 'session', 'explicit-skills.mjs');
const { makeToolEnvelope } = await load('runtime', 'agent', 'orchestrator', 'session', 'tool-envelope.mjs');
const { invalidateSkillsCache, collectPromptSkillsCached } = await load('runtime', 'agent', 'orchestrator', 'context', 'collect.mjs');
const { SKILL_TOOL } = await load('runtime', 'agent', 'orchestrator', 'runtime-core', 'tool-defs.mjs');
const { applyDeferredToolSurface } = await load('runtime', 'agent', 'orchestrator', 'runtime-core', 'tool-catalog.mjs');

const names = ['alpha', 'beta-two', 'pptx', 'path', 'a', 'x1', 'skill-1', 'skill-2', 'skill-3', 'skill-4', 'skill-5', 'skill-6'];
for (const name of names) {
  mkdirSync(join(base, 'data', 'skills', name), { recursive: true });
  writeFileSync(join(base, 'data', 'skills', name, 'SKILL.md'), `---\nname: ${name}\ndescription: Use when ${name}.\n---\n\n# ${name}\n`);
}
invalidateSkillsCache(join(base, 'data'));
const cwd = join(base, 'proj');
mkdirSync(cwd, { recursive: true });

const body = (name) => `<skill>\n<name>${name}</name>\nBody of ${name}\n</skill>`;
// What the Skill tool answers, by skill.
// A string is a bare result; an object is an envelope (`result`, then the bodies it injects).
const answers = {
  alpha: { result: 'Loaded skill: alpha', bodies: [body('alpha')] },
  pptx: 'Loaded built-in skill: pptx',
  'beta-two': 'Error: skill "beta-two" not found',
  path: 'Error: skill "path" is turned off',
  a: { result: 'Loaded skill: a (already active; instructions unchanged — follow them without calling Skill again)', bodies: [] },
  x1: { result: 'Loaded skill: x1', bodies: [body('x1'), 'second'] },
};
const answerFor = (name) => {
  const answer = answers[name] ?? `Loaded skill: ${name}`;
  if (typeof answer === 'string') return answer;
  return makeToolEnvelope(answer.result, answer.bodies.map((content) => ({ role: 'user', content, meta: 'skill' })));
};
const available = collectPromptSkillsCached(cwd).map((skill) => skill.name);
const prompts = [
  '$alpha',
  '$pptx',
  '$beta-two',
  '$path',
  '$a',
  '$x1',
  '$alpha $pptx $beta-two $a',
  'Skill: "pptx"\n\nuse $alpha then $pptx',
  'nothing selected here',
  '$skill-1 $skill-2 $skill-3 $skill-4 $skill-5 $skill-6',
  [{ type: 'text', text: 'Skill: "alpha"\n\nrun' }, { type: 'text', text: '$x1' }],
];
const cases = [];
for (const prompt of prompts) {
  const session = { provider: 'openai-oauth', cwd, toolSpec: 'full', tools: [SKILL_TOOL], messages: [{ role: 'system', content: 's' }], compaction: { auto: false } };
  applyDeferredToolSurface(session, 'full');
  const messages = [{ role: 'user', content: typeof prompt === 'string' ? prompt : 'parts' }];
  const calls = [];
  const execute = async (tool, args) => {
    calls.push({ tool, args });
    return answerFor(args.name);
  };
  const applied = await prepareExplicitSkills(prompt, messages, session, { cwd, execute });
  const ids = [];
  const shown = messages.slice(1).map((message) => JSON.parse(JSON.stringify(message, (key, value) => (key === 'id' || key === 'toolCallId' ? (ids.push(value), `<ID${ids.length}>`) : value))));
  cases.push({ prompt, calls, applied, messages: shown });
}
writeFileSync(out, JSON.stringify({ available, answers, cases }, null, 1));
