// A 1.4.5 process that dies while one of its writers publishes a file: the product's own writer has created its temp file
// and the process is killed at the step that would publish it (the rename, or the link of a lock), as a power cut between
// the two leaves it. One writer per run, selected by <case>; the path of the temp file it left is written to <result file>.
// Run by record-migration-145.mjs on a scratch copy of the recorded directory with the recorded environment.
//   argv: <tree> <home> <case> <result file> <session id>
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { workflowAgentsApi } from './migration-145-api.mjs';

const [tree, home, kind, resultFile, sessionId] = process.argv.slice(2);
const data = join(home, 'data');
const at = (p) => import(pathToFileURL(join(tree, p)).href);
const slash = (p) => String(p).replaceAll('\\', '/');

let arm = () => false;
const cut = (from) => {
  fs.writeFileSync(resultFile, String(from));
  process.kill(process.pid, 'SIGKILL');
};
const wrap = (target, name, op) => {
  const real = target[name];
  target[name] = (from, to, ...rest) => {
    if (arm(op, slash(from), slash(to))) cut(from);
    return real.call(target, from, to, ...rest);
  };
};
wrap(fs, 'renameSync', 'rename');
wrap(fs.promises, 'rename', 'rename');
wrap(fs, 'linkSync', 'link');
wrap(fs.promises, 'link', 'link');
syncBuiltinESMExports();

const onRename = (test) => (op, from, to) => op === 'rename' && test(from, to);
const into = (dir) => onRename((_from, to) => to.includes(`/${dir}/`));

const cases = {
  goals: async () => {
    arm = into('goals');
    const { createGoalRuntime } = await at('src/runtime/agent/orchestrator/runtime-core/goal-runtime.mjs');
    await createGoalRuntime({ dataDir: data }).control(sessionId, { action: 'create', objective: 'A goal whose write was cut' });
  },
  'human-gate': async () => {
    arm = into('human-gate');
    const gate = await at('src/runtime/agent/orchestrator/session/human-gate/store.mjs');
    await gate.setAgentPermission('reviewer', 'comment', 'allow');
  },
  hooks: async () => {
    arm = into('hooks');
    fs.mkdirSync(join(data, 'hooks'), { recursive: true });
    const { updateHookRules } = await at('src/session-runtime/services/hook-bus/rule-file.mjs');
    updateHookRules(join(data, 'hooks', 'hooks.json'), (rules) => [...rules, { matcher: '*', command: 'echo cut' }]);
  },
  'prompt-history': async () => {
    arm = into('tui-prompt-history');
    const history = await at('src/tui/prompt-history-store.mjs');
    history.appendPromptHistory(join(home, 'work'), 'a prompt whose write was cut');
    process.emit('exit', 0);
  },
  agents: async () => {
    arm = into('agents');
    await (await workflowAgentsApi(tree, data)).saveAgentDefinition({ name: 'Cut Agent', description: 'cut', body: 'cut', kind: 'agent' });
  },
  bots: async () => {
    arm = into('bots');
    await (await workflowAgentsApi(tree, data)).saveAgentDefinition({ name: 'Cut Bot', description: 'cut', body: 'cut', kind: 'bot' });
  },
  workflows: async () => {
    arm = into('workflows');
    await (await workflowAgentsApi(tree, data)).createWorkflow({ name: 'Cut flow', description: 'cut', body: 'cut' });
  },
  skills: async () => {
    arm = into('skills');
    const { createSkillsApi } = await at('src/session-runtime/skills-api.mjs');
    createSkillsApi({ contextMod: {}, getCwd: () => home }).addGlobalSkill({ name: 'cut-skill', description: 'cut' });
  },
  'data-root': async () => {
    arm = onRename((_from, to) => to.endsWith('/data/mixdog-config.json'));
    (await at('src/runtime/shared/config.mjs')).updateConfig((config) => ({ ...config, ui: { theme: 'light' } }));
  },
  attachments: async () => {
    arm = into('prompt-attachments');
    (await at('src/runtime/attachments/store.mjs')).storeAttachmentBuffer(Buffer.from('a blob whose write was cut'));
  },
  'session-save': async () => {
    arm = onRename((_from, to) => /\/sessions\/[^/]+\.json$/.test(to));
    const store = await at('src/runtime/agent/orchestrator/session/store.mjs');
    const session = store.loadSession(sessionId);
    session.updatedAt = Date.now();
    store.saveSession(session);
  },
  'compaction-pending': async () => {
    arm = onRename((_from, to) => to.endsWith('.compaction-archive.pending'));
    const { session, before, after, capture } = await compaction();
    capture.prepareCompactionArchive({ session, before, after });
  },
  'compaction-archive': async () => {
    const { session, before, after, capture } = await compaction();
    capture._setCompactionArchivePublishHook(({ tmp }) => cut(tmp));
    await capture.scheduleCompactionArchive({ session, before, after }).written;
  },
  'lock-stage': async () => {
    arm = (op, from) => op === 'link' && from.endsWith('.tmp');
    const { withFileLockSync } = await at('src/runtime/shared/file-lock.mjs');
    withFileLockSync(join(data, 'quota-resume.json.lock'), () => {});
  },
  // Not a cut write: a session record a crash left NUL-filled, kept aside by the product as '<id>.json.corrupt-<ts>' (the
  // set-aside the migration keeps in quarantine).
  'set-aside': async () => {
    const manager = await at('src/runtime/agent/orchestrator/session/manager.mjs');
    const { setAsideDamagedSessionRecord } = await at('src/runtime/agent/orchestrator/session/store/canonical-reader.mjs');
    const { _withRegisteredProviderForTestAsync } = await at('src/runtime/agent/orchestrator/providers/registry.mjs');
    let session;
    await _withRegisteredProviderForTestAsync('stub', { name: 'stub', contextWindow: 128000, async send() {} }, async () => {
      session = manager.createSession({ provider: 'stub', model: 'stub-model', cwd: home, owner: 'user', sourceType: 'lead', agent: 'lead' });
      (await at('src/runtime/agent/orchestrator/session/store.mjs')).saveSession(session);
    });
    const file = join(data, 'sessions', `${session.id}.json`);
    fs.writeFileSync(file, Buffer.alloc(512));
    if (!setAsideDamagedSessionRecord(file)) throw new Error('the damaged record was not set aside');
    const aside = fs.readdirSync(join(data, 'sessions')).find((name) => name.startsWith(`${session.id}.json.corrupt-`));
    fs.writeFileSync(resultFile, join(data, 'sessions', aside));
    return 'reported';
  },
  'owner-refresh': async () => {
    arm = onRename((_from, to) => to.endsWith('/data/daemon-owner.json'));
    const { refreshSingletonOwnerAsync } = await at('src/runtime/shared/singleton-owner.mjs');
    await refreshSingletonOwnerAsync(join(data, 'daemon-owner.json'), { kind: 'daemon', pid: process.pid, claimedAt: Date.now() });
  },
};

async function compaction() {
  const capture = await at('src/runtime/agent/orchestrator/session/compaction-archive-capture.mjs');
  const store = await at('src/runtime/agent/orchestrator/session/store.mjs');
  const session = store.loadSession(sessionId);
  const messages = [
    { role: 'user', content: 'a message the compaction drops' },
    { role: 'assistant', content: 'its answer, dropped too' },
    { role: 'user', content: 'the message that stays' },
  ];
  capture.stampCompactionMessageIds(messages, sessionId);
  return { capture, session, before: messages, after: messages.slice(2) };
}

if ((await cases[kind]()) === 'reported') process.exit(0);
console.error(`${kind}: the writer finished without being cut`);
process.exit(3);
