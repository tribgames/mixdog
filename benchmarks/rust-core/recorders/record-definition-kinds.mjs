#!/usr/bin/env node
// Golden twin of the workflow and skill kinds of the definition setup actions: what Node's real
// handlers (setup-tool/extended-actions.mjs create/save/delete/read_definition, and
// agent-settings-actions.mjs restore_definition) ask of the runtime, and what they answer.
// The runtime here is a recording stand-in with canned answers (the services under it have
// their own twins); the twin pins the handler's own logic: the field checks, what an edit keeps
// of the stored definition, and the calls it makes.
//
//   node benchmarks/rust-core/recorders/record-definition-kinds.mjs --tree <dir>
import { FIXTURES_ROOT, importFrom, parseArgs, resolveTree, writeJson } from './lib/common.mjs';

const tree = resolveTree(parseArgs());
const { EXTENDED_SETUP_HANDLERS } = await importFrom(tree, 'src/session-runtime/setup-tool/extended-actions.mjs');
const { AGENT_SETTINGS_HANDLERS } = await importFrom(tree, 'src/session-runtime/setup-tool/agent-settings-actions.mjs');
const handlers = { ...EXTENDED_SETUP_HANDLERS, ...AGENT_SETTINGS_HANDLERS };

// The canned world both sides share.
const world = {
  workflows: {
    alpha: { id: 'alpha', name: 'Alpha', description: 'first', source: 'user', body: 'Alpha body', userOverride: true },
    beta: { id: 'beta', name: 'Beta', description: '', source: 'built-in', body: 'Beta body', userOverride: false },
  },
  skills: {
    mine: { content: 'Body of mine', row: { name: 'mine', description: 'Mine', whenToUse: 'Probe', editable: true, toolDependencies: [] } },
    builtin: { content: 'Body of builtin', row: { name: 'builtin', description: 'Built in', whenToUse: '', editable: false, toolDependencies: [{ type: 'tool', value: 'setup' }] } },
    bare: { content: 'Bare body', row: { name: 'bare', editable: true } },
  },
};

function runtime(log) {
  const record = (method, params, answer) => {
    log.push({ method, params: JSON.parse(JSON.stringify(params ?? null)) });
    return answer;
  };
  return {
    getWorkflowPack(name) {
      record('config/getWorkflowPack', { workflowId: name });
      const pack = world.workflows[name];
      if (!pack) throw new Error(`workflow "${name}" not found`);
      return pack;
    },
    createWorkflow: (payload) => record('config/createWorkflow', { payload }, { created: payload }),
    saveWorkflowPack: (payload) => record('config/saveWorkflowPack', { payload }, { saved: payload }),
    deleteWorkflow: (name) => record('config/deleteWorkflow', { workflowId: name }, { id: name, deleted: true, revertedToBuiltIn: false }),
    skillContent(name) {
      record('skills/skillContent', { name });
      const skill = world.skills[name];
      if (!skill) throw new Error(`skill not found: ${name}`);
      return { content: skill.content, name };
    },
    skillsStatus() {
      record('skills/skillsStatus', {});
      return { skills: Object.values(world.skills).map((skill) => skill.row) };
    },
    addSkill: (input) => record('skills/addSkill', { input }, { skill: { name: input.name }, status: {} }),
    saveSkill: (input) => record('skills/saveSkill', { input }, { skill: { name: input.name ?? input.originalName }, status: {} }),
  };
}

let seed = 0x7a31c5;
const next = () => {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  return seed / 2 ** 32;
};
const chance = (p) => next() < p;
const pick = (list) => list[Math.floor(next() * list.length)];

const BODIES = ['New body', '  ', '', 'Line one\nLine two', 'x'];
const DEPS = [null, [], [{ type: 'tool', value: 'memory' }], [{ type: 'mcp', value: 'srv' }]];

function workflowDefinition(creating) {
  const definition = {};
  if (chance(0.7)) definition[creating ? pick(['name', 'name', 'id']) : pick(['id', 'name'])] = pick(['alpha', 'beta', 'ghost', 'New Pack', '']);
  if (chance(0.5)) definition.name = pick(['Renamed', 'Alpha']);
  if (chance(0.6)) definition.body = pick(BODIES);
  if (chance(0.4)) definition.description = pick(['', 'changed']);
  if (chance(0.08)) definition.whenToUse = 'not a workflow field';
  if (chance(0.06)) definition.kind = 'bot';
  return definition;
}

function skillDefinition(creating) {
  const definition = {};
  if (!creating || chance(0.2)) definition.originalName = pick(['mine', 'mine', 'builtin', 'bare', 'ghost']);
  if (chance(0.5)) definition.name = pick(['mine', 'renamed', 'builtin', 'fresh-skill']);
  if (chance(0.6)) definition.body = pick(BODIES);
  if (chance(0.4)) definition.description = pick(['', 'changed']);
  if (chance(0.3)) definition.whenToUse = pick(['', 'when needed']);
  if (chance(0.4)) definition.toolDependencies = pick(DEPS);
  if (chance(0.06)) definition.id = 'not-a-skill-field';
  return definition;
}

function makeArgs() {
  const kind = pick(['workflow', 'workflow', 'skill', 'skill', 'agent']);
  const roll = next();
  if (kind === 'agent') {
    return { action: 'restore_definition', definitionKind: pick(['workflow', 'skill']), name: pick(['alpha', 'mine']) };
  }
  if (roll < 0.25) return { action: 'create_definition', definitionKind: kind, definition: kind === 'workflow' ? workflowDefinition(true) : skillDefinition(true) };
  if (roll < 0.5) return { action: 'save_definition', definitionKind: kind, definition: kind === 'workflow' ? workflowDefinition(false) : skillDefinition(false) };
  if (roll < 0.7) return { action: 'delete_definition', definitionKind: kind, name: pick(['alpha', 'beta', 'mine', 'builtin', 'ghost']) };
  if (roll < 0.85) return { action: 'read_definition', definitionKind: kind, name: pick(['alpha', 'mine', 'builtin', 'bare', 'ghost']) };
  return { action: 'restore_definition', definitionKind: kind, name: pick(['alpha', 'mine']) };
}

const cases = [];
for (let index = 0; index < 400; index += 1) {
  const args = makeArgs();
  const calls = [];
  let outcome;
  try {
    outcome = { ok: JSON.parse(JSON.stringify(await handlers[args.action](runtime(calls), args, { caller: { id: 'sess_task_1' } }))) };
  } catch (error) {
    outcome = { error: String(error?.message ?? error) };
  }
  cases.push({ args, calls, ...outcome });
}

writeJson(`${FIXTURES_ROOT}/desktop/settings/definition-kinds-twin.json`, {
  domain: 'definition-kinds-twin',
  recorder: 'benchmarks/rust-core/recorders/record-definition-kinds.mjs',
  world,
  cases,
});
console.log(`recorded ${cases.length} calls`);
