#!/usr/bin/env node
// What a `$skill` chip is made of (`recordAppliedSkills`, session/explicit-skills.mjs): the skills a user turn loaded,
// stamped on that turn's stored row (`meta.transcript.appliedSkills`) and read back as the row's chips after a restart.
// The three paths of Node's explicit-skills-persist.test.mjs, driven as the product drives them over the real session
// store, the real Skill tool and two skills on disk: inline `$name` mentions on an ask turn, a header-only selection
// (`skillSelectionHeader`), and a prompt queued into a running turn (the loop's drain). Per case: the prompt, the names
// the preparation reported applied, every stored user row's `meta.transcript` as the durable record holds it, and the
// restored user rows (`restoreTranscriptItems`) with their chips.
//
//   node benchmarks/rust-core/recorders/record-applied-skills.mjs --tree <exact export of b6f10295a>
// Output: native/core/fixtures/applied-skills/golden.json
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recorderProvenance } from './lib/provenance.mjs';
import { FIXTURES_ROOT, commitStage, exactProductIdentity, importFrom, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } from './lib/common.mjs';

const NODE_COMMIT = 'b6f10295a2f698afc85332467192de28500bd146';
const recorder = 'benchmarks/rust-core/recorders/record-applied-skills.mjs';
const SKILLS = ['selected-guide', 'other-guide'];

const args = parseArgs();
const tree = resolveTree(args);
const identity = exactProductIdentity(tree, NODE_COMMIT);
const root = mkdtempSync(join(tmpdir(), 'mixdog-applied-skills-'));
process.env.MIXDOG_DATA_DIR = root;
for (const name of SKILLS) {
  mkdirSync(join(root, 'skills', name), { recursive: true });
  writeFileSync(join(root, 'skills', name, 'SKILL.md'), `---\nname: ${name}\ndescription: Exercise persisted skill selection.\n---\n# ${name}\nFollow it.\n`);
}

const orch = 'src/runtime/agent/orchestrator';
const { saveSessionAsync } = await importFrom(tree, `${orch}/session/store.mjs`);
const { readDurableSessionRecord } = await importFrom(tree, `${orch}/session/store/transcript-durability.mjs`);
const { settleSessionSummaryIndex } = await importFrom(tree, `${orch}/session/store/listing.mjs`);
const { invalidateSkillsCache } = await importFrom(tree, `${orch}/context/collect.mjs`);
const { prepareExplicitSkills, recordAppliedSkills } = await importFrom(tree, `${orch}/session/explicit-skills.mjs`);
const { restoreTranscriptItems } = await importFrom(tree, `${orch}/session/transcript-restore/restore.mjs`);
const { skillSelectionHeader } = await importFrom(tree, 'src/runtime/shared/skill-selection.mjs');
const { SKILL_TOOL } = await importFrom(tree, `${orch}/runtime-core/tool-defs.mjs`);
const { applyDeferredToolSurface } = await importFrom(tree, `${orch}/runtime-core/tool-catalog.mjs`);
const { agentLoop } = await importFrom(tree, `${orch}/session/agent-loop.mjs`);
invalidateSkillsCache(root);

let sequence = 0;
function newSession() {
  sequence += 1;
  const now = Date.now();
  const session = {
    id: `sess_applied_skills_${sequence}`,
    owner: 'user',
    status: 'idle',
    createdAt: now,
    updatedAt: now,
    provider: 'openai-oauth',
    cwd: root,
    toolSpec: 'full',
    tools: [SKILL_TOOL],
    messages: [
      { role: 'system', content: 'Stable instructions.' },
      { role: 'user', content: 'Earlier task', meta: { transcript: { messageId: 'msg_earlier' } } },
      { role: 'assistant', content: 'Earlier answer.' },
    ],
    compaction: { auto: false },
  };
  applyDeferredToolSurface(session, 'full');
  return session;
}

// The stored rows as a restarted app reads them: the durable record (its log, never a cached copy).
function stored(session) {
  const disk = readDurableSessionRecord(session.id);
  const users = disk.messages.filter((message) => message.role === 'user' && !message.meta?.source);
  return {
    userTranscripts: users.map((message) => message.meta?.transcript ?? null),
    restoredUserRows: restoreTranscriptItems(disk.messages)
      .filter((item) => item.kind === 'user')
      .map((item) => ({ messageId: item.messageId ?? null, appliedSkills: item.appliedSkills ?? null })),
  };
}

// One ask turn the way prepareAskTurn/runAskAgentLoop drive it.
async function askTurn(prompt) {
  const session = newSession();
  const userMessage = { role: 'user', content: prompt, meta: { transcript: { messageId: 'msg_turn' } } };
  const outgoing = [...session.messages, userMessage];
  const beforeCount = outgoing.length;
  session.messages = outgoing.slice();
  await saveSessionAsync(session);
  const applied = await prepareExplicitSkills(prompt, outgoing, session, { cwd: root });
  recordAppliedSkills(outgoing, outgoing[beforeCount - 1], applied);
  session.messages = outgoing.slice();
  outgoing.push({ role: 'assistant', content: 'Done.' });
  session.messages = outgoing.slice();
  await saveSessionAsync(session);
  return { prompt, applied, ...stored(session) };
}

// A prompt queued into a running turn: drained after the first reply, prepared before the next request.
async function queuedTurn(first, queued) {
  const session = newSession();
  const outgoing = [...session.messages, { role: 'user', content: first }];
  session.messages = outgoing.slice();
  await saveSessionAsync(session);
  let sends = 0;
  let drained = false;
  const applied = [];
  await agentLoop(
    {
      name: 'openai-oauth',
      async send() {
        sends += 1;
        return { content: 'Done.', toolCalls: [], stopReason: 'end_turn' };
      },
    },
    outgoing,
    'fake-model',
    session.tools,
    null,
    root,
    {
      session,
      onSkillsApplied: (names) => applied.push(...names),
      drainSteering() {
        if (sends !== 1 || drained) return [];
        drained = true;
        return [{ mode: 'prompt', content: queued, transcriptMeta: { messageId: 'msg_queued' } }];
      },
    }
  );
  session.messages = outgoing.slice();
  await saveSessionAsync(session);
  return { prompt: first, queued, applied, ...stored(session) };
}

const cases = [
  { name: 'inline mentions', ...(await askTurn('Review with $selected-guide then $other-guide and $HOME.')) },
  { name: 'header-only selection', ...(await askTurn(`${skillSelectionHeader('selected-guide')}Do the work.`)) },
  { name: 'queued prompt', ...(await queuedTurn('First task', 'Next: use $other-guide.')) },
  { name: 'no skill named', ...(await askTurn('Nothing to load, $nobody.')) },
];

await settleSessionSummaryIndex();
await (await importFrom(tree, `${orch}/session/store/lifecycle-barriers.mjs`)).flushSessionCloseMetrics();
invalidateSkillsCache(root);
(await importFrom(tree, `${orch}/session/store/session-writer-claim.mjs`)).releaseHeldSessionWriters();
rmSync(root, { recursive: true, force: true });

const finalOut = join(FIXTURES_ROOT, 'applied-skills');
const out = stageSet(finalOut);
writeJson(join(out, 'golden.json'), {
  note: 'recordAppliedSkills through the real persist path: the applied names, the stored user rows and the restored chips',
  skills: SKILLS,
  cases,
});
writeSetManifest(out, {
  set: 'applied-skills',
  recorder,
  command: `node ${recorder} --tree <exact export of ${NODE_COMMIT}>`,
  identity,
  extra: {
    ...recorderProvenance(import.meta.url),
    cases: cases.length,
    syntheticInputs: [
      'the sessions: three stored rows before the turn (system, an earlier user turn, its answer), the Skill tool only',
      'the skills: two SKILL.md files under MIXDOG_DATA_DIR/skills',
      'the provider of the queued case: one that answers "Done." and calls no tool',
    ],
    keptWhole: 'per case: the prompt, the applied names, every stored user row meta.transcript, the restored user rows',
  },
});
commitStage(out, finalOut);
console.log(`cases=${cases.length}`);
process.exit(0);
