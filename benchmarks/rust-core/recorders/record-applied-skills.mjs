#!/usr/bin/env node
// What a `$skill` chip is made of (`recordAppliedSkills`, session/explicit-skills.mjs), recorded through the product's own turn: a
// real `askSession` (createSession, the ask turn's `prepareExplicitSkills` with the real Skill tool over SKILL.md files on disk) against
// a scripted provider, the store's own writes, the fork the desktop makes (`createInheritance().inheritFrom`) and a manual compaction
// (`compactSessionMessages`). Per case: the prompt(s), the names the turn reported applied (`onSkillsApplied`), every user row the
// durable record holds (whole: role, content, meta) and every user row `restoreTranscriptItems` restores from it (whole).
//
// Cases: inline `$name` mentions; a header-only selection (`skillSelectionHeader`); a prompt queued into the running turn
// (`enqueuePendingMessage` while the first request is held; the loop's drain prepares it); no skill named; a duplicate (the header
// and two inline mentions of one skill); a skill that fails to load (listed, its SKILL.md removed before the turn); a fork of a session
// whose prompt has chips; the same after a manual compaction.
//
// The clock and the random draws are the deterministic world's (lib/deterministic-world.mjs); the sandbox folder becomes <SANDBOX>.
//
//   node benchmarks/rust-core/recorders/record-applied-skills.mjs --tree <exact export of b6f10295a with node_modules>
// Output: native/core/fixtures/applied-skills/golden.json
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recorderProvenance } from './lib/provenance.mjs';
import { installDeterministicWorld } from './lib/deterministic-world.mjs';
import { FIXTURES_ROOT, commitStage, exactProductIdentity, importFrom, parseArgs, resolveTree, stageSet, within, writeJson, writeSetManifest } from './lib/common.mjs';

const NODE_COMMIT = 'b6f10295a2f698afc85332467192de28500bd146';
const recorder = 'benchmarks/rust-core/recorders/record-applied-skills.mjs';
const SKILLS = ['selected-guide', 'other-guide', 'broken-guide'];

const args = parseArgs();
const tree = resolveTree(args);
const identity = exactProductIdentity(tree, NODE_COMMIT);
const sandbox = mkdtempSync(join(process.env.MIXDOG_RECORDER_SCRATCH ?? tmpdir(), 'rec-applied-skills-'));
for (const name of ['MIXDOG_DATA_DIR', 'MIXDOG_HOME', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA']) process.env[name] = join(sandbox, name.toLowerCase());
for (const [k, v] of Object.entries(JSON.parse(readFileSync(join(tree, 'src/runtime/shared/pristine-execution-contract.json'), 'utf8')).guardEnv)) {
  if (k !== 'MIXDOG_DISABLE_MCP' && k !== 'MIXDOG_DISABLE_SKILLS') process.env[k] = v;
}
process.env.MIXDOG_SKIP_USER_DATA_BACKUP = '1';
process.env.MIXDOG_AGENT_TRACE_DISABLE = '1';
process.env.MIXDOG_DISABLE_PROVIDER_WARMUP = '1';
process.env.MIXDOG_DISABLE_MODEL_PREFETCH = '1';
process.env.MIXDOG_DISABLE_MODEL_CATALOG_WARMUP = '1';
const data = process.env.MIXDOG_DATA_DIR;
const work = join(sandbox, 'work');
mkdirSync(work, { recursive: true });
const skillFile = (name) => join(data, 'skills', name, 'SKILL.md');
for (const name of SKILLS) {
  mkdirSync(join(data, 'skills', name), { recursive: true });
  writeFileSync(skillFile(name), `---\nname: ${name}\ndescription: Exercise persisted skill selection.\n---\n# ${name}\nFollow it.\n`);
}

const world = installDeterministicWorld({ start: 1_800_000_000_000, pid: 4242 });
const orch = 'src/runtime/agent/orchestrator';
const load = (rel) => importFrom(tree, rel);
const manager = await load(`${orch}/session/manager.mjs`);
const { saveSession } = await load(`${orch}/session/store.mjs`);
const { _withRegisteredProviderForTestAsync } = await load(`${orch}/providers/registry.mjs`);
const { readDurableSessionRecord } = await load(`${orch}/session/store/transcript-durability.mjs`);
const { settleRecorder } = await load(`${orch}/session/store/session-writers.mjs`);
const { awaitPreviousTurnDurable } = await load(`${orch}/session/manager/turn-durability.mjs`);
const { restoreTranscriptItems } = await load(`${orch}/session/transcript-restore/restore.mjs`);
const { skillSelectionHeader } = await load('src/runtime/shared/skill-selection.mjs');
const { createInheritance } = await load('src/session-runtime/lifecycle/inheritance.mjs');

const PROVIDER = 'skills-stub';
// Each request is held until the script lets it go; a summary request (the compaction's) answers a summary.
const sends = [];
const held = [];
const stub = {
  name: PROVIDER,
  contextWindow: 128000,
  async send(messages) {
    const last = [...messages].reverse().find((m) => m.role === 'user');
    const text = typeof last?.content === 'string' ? last.content : JSON.stringify(last?.content ?? '');
    sends.push(text);
    sentOne?.();
    if (holding) await new Promise((resolve) => held.push(resolve));
    const summary = /summar|compact/i.test(text);
    return { content: summary ? 'a summary of the conversation' : 'Done.', toolCalls: [], stopReason: 'end_turn', usage: { inputTokens: 100, outputTokens: 20 } };
  },
};
let holding = false;
// Resolves when the stub receives its next request (the first request of a held turn).
let sentOne = null;
const route = { provider: PROVIDER, model: 'stub-model' };
const placeholder = (value) => JSON.parse(JSON.stringify(value).split(JSON.stringify(sandbox).slice(1, -1)).join('<SANDBOX>').split(sandbox.replaceAll('\\', '/')).join('<SANDBOX>'));

async function settled(id) {
  await within('the turn durable', awaitPreviousTurnDurable(id));
  await within('the writer settled', settleRecorder(id));
}

// The user rows as a restarted app reads them: the durable record, and what restore makes of it.
async function stored(id) {
  await settled(id);
  const disk = readDurableSessionRecord(id);
  return {
    userRows: disk.messages.filter((message) => message.role === 'user'),
    restoredUserRows: restoreTranscriptItems(disk.messages).filter((item) => item.kind === 'user'),
  };
}

let sequence = 0;
function newSession() {
  world.advance(1000);
  sequence += 1;
  return manager.createSession({ ...route, id: `sess_applied_skills_${sequence}`, owner: 'user', sourceType: 'lead', agent: 'lead', cwd: work });
}

// What a client's turn carries for its prompt row (the desktop draws the ids, the time and the completion verb, and names its
// device); the replay's core draws its own, which the comparison takes as identities.
const turnMeta = (messageId) => ({ messageId, attemptId: `attempt_${messageId}`, checkpointId: `checkpoint_${messageId}`, at: 1000, device: 'desktop-1', completionVerb: 'Mapped' });

async function ask(id, prompt, messageId, applied) {
  world.advance(1000);
  await within(`ask ${id}`, manager.askSession(id, prompt, null, undefined, work, undefined, { transcriptMeta: turnMeta(messageId), onSkillsApplied: (names) => applied.push(...names) }));
}

async function askCase(name, prompt) {
  const session = newSession();
  const applied = [];
  await ask(session.id, prompt, 'msg_turn', applied);
  return { name, prompt, applied, ...(await stored(session.id)) };
}

async function queuedCase(name, first, queued) {
  const session = newSession();
  const applied = [];
  holding = true;
  const firstRequest = new Promise((resolve) => {
    sentOne = resolve;
  });
  world.advance(1000);
  const turn = manager.askSession(session.id, first, null, undefined, work, undefined, { transcriptMeta: turnMeta('msg_turn'), onSkillsApplied: (names) => applied.push(...names) });
  await within('the first request of the held turn', firstRequest);
  sentOne = null;
  manager.enqueuePendingMessage(session.id, { mode: 'prompt', content: queued, transcriptMeta: { messageId: 'msg_queued' } });
  holding = false;
  for (const release of held.splice(0)) release();
  await within('the queued turn', turn);
  return { name, prompt: first, queued, applied, ...(await stored(session.id)) };
}

const cases = [];
await _withRegisteredProviderForTestAsync(PROVIDER, stub, async () => {
  cases.push(await askCase('inline mentions', 'Review with $selected-guide then $other-guide and $HOME.'));
  cases.push(await askCase('header-only selection', `${skillSelectionHeader('selected-guide')}Do the work.`));
  cases.push(await queuedCase('queued prompt', 'First task', 'Next: use $other-guide.'));
  cases.push(await askCase('no skill named', 'Nothing to load, $nobody.'));
  cases.push(await askCase('a duplicate', `${skillSelectionHeader('selected-guide')}Use $selected-guide, then $selected-guide again.`));
  // The earlier turns read the listing with broken-guide in it; its file is removed, and the next turn's listing no longer
  // names it, so its mention stays prose and only other-guide loads.
  rmSync(skillFile('broken-guide'));
  cases.push({ ...(await askCase('a skill that fails to load', 'Use $broken-guide and $other-guide.')), removed: ['broken-guide'] });
  // The desktop's fork (`inheritSession`): an heir created where the source is, then inheritFrom carries the conversation into it.
  const source = newSession();
  const sourceApplied = [];
  await ask(source.id, 'Fork me with $selected-guide.', 'msg_turn', sourceApplied);
  await settled(source.id);
  world.advance(60_000);
  const heir = manager.createSession({ ...route, owner: 'user', sourceType: 'lead', agent: 'lead', cwd: work });
  const inheritance = createInheritance(
    { getSession: () => manager.getSession(heir.id), getRoute: () => route, mgr: manager, createCurrentSession: null, invalidateContextStatusCache() {}, getReservedSessionId: () => null },
    { compactConversation: async () => null, saveSession }
  );
  await within('inherit', inheritance.inheritFrom(source.id, { compact: false }));
  cases.push({ name: 'a fork', prompt: 'Fork me with $selected-guide.', applied: sourceApplied, ...(await stored(heir.id)) });
  // A manual compaction of a session whose first prompt has chips, after enough turns that it really trims.
  const compacted = newSession();
  const compactedApplied = [];
  await ask(compacted.id, `Start with $selected-guide. ${'context '.repeat(400)}`, 'msg_turn', compactedApplied);
  for (let turn = 0; turn < 6; turn += 1) await ask(compacted.id, `request ${turn} ${'context '.repeat(400)}`, `msg_${turn}`, compactedApplied);
  world.advance(1000);
  const result = await within('compact', manager.compactSessionMessages(compacted.id));
  cases.push({ name: 'a compaction', prompt: 'Start with $selected-guide.', applied: compactedApplied, compaction: { changed: result?.changed ?? null }, ...(await stored(compacted.id)) });
});

const finalOut = join(FIXTURES_ROOT, 'applied-skills');
const out = stageSet(finalOut);
writeJson(join(out, 'golden.json'), placeholder({
  note: 'recordAppliedSkills through a real askSession: the applied names, every stored user row and every restored user row, whole',
  skills: SKILLS,
  cases,
}));
writeSetManifest(out, {
  set: 'applied-skills',
  recorder,
  command: `node ${recorder} --tree <exact export of ${NODE_COMMIT}>`,
  identity,
  extra: {
    ...recorderProvenance(import.meta.url),
    cases: cases.length,
    syntheticInputs: [
      'the provider: one that answers "Done." (a summary request: "a summary of the conversation") and calls no tool',
      'the skills: three SKILL.md files under MIXDOG_DATA_DIR/skills; broken-guide\'s file is removed before its case',
      'each prompt\'s transcriptMeta, as a client turn carries it: { messageId (msg_turn, msg_<n>), attemptId, checkpointId, at: 1000, device: "desktop-1", completionVerb: "Mapped" }',
    ],
    keptWhole: 'per case: the prompt(s), the applied names, every stored user row, every restored user row',
    exclusions: {
      'meta.transcript.messageId / attemptId / checkpointId': 'the client turn carried Node\'s (turnMeta); the core draws its own, so both sides are compared as an id (a non-empty string)',
      'meta.submissionIds': 'a steered prompt\'s submission id is drawn by each side; the count and non-empty ids are compared',
      'restored row messageId / attemptId / checkpointId (the row\'s own top-level keys)': 'a restored user row repeats the stored row\'s transcript ids at its top level; the same identities as meta.transcript.*, drawn by the core, compared as an id (a non-empty string) on both sides',
      'restored row id':'Node counts hist_<session>_<n>, the core uses the record\'s iid; both sides are compared as an id',
    },
  },
});
commitStage(out, finalOut);
(await load(`${orch}/session/store/session-writer-claim.mjs`)).releaseHeldSessionWriters();
rmSync(sandbox, { recursive: true, force: true });
console.log(`cases=${cases.length}`);
process.exit(0);
