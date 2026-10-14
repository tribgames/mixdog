// appliedSkills through the real persist path: preflight save of the user turn
// (the save worker's delta baseline now holds that message), skill preparation
// stamps the turn, the commit save lands, and the session file read back from
// disk restores the user row with appliedSkills — ask turns, header-only
// selections and queued prompts alike.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const root = mkdtempSync(join(tmpdir(), 'mixdog-applied-skills-persist-'));
process.env.MIXDOG_DATA_DIR = root;
for (const name of ['selected-guide', 'other-guide']) {
  mkdirSync(join(root, 'skills', name), { recursive: true });
  writeFileSync(
    join(root, 'skills', name, 'SKILL.md'),
    `---\nname: ${name}\ndescription: Exercise persisted skill selection.\n---\n# ${name}\nFollow it.\n`
  );
}

const { saveSessionAsync } = await import('./store.mjs');
const { settleSessionSummaryIndex } = await import('./store/listing.mjs');
const { invalidateSkillsCache } = await import('../context/collect.mjs');
const { prepareExplicitSkills, recordAppliedSkills } = await import('./explicit-skills.mjs');
const { restoreTranscriptItems } = await import('./transcript-restore/restore.mjs');
const { skillSelectionHeader } = await import('../../../shared/skill-selection.mjs');
const { SKILL_TOOL } = await import('../runtime-core/tool-defs.mjs');
const { applyDeferredToolSurface } = await import('../runtime-core/tool-catalog.mjs');
const { agentLoop } = await import('./agent-loop.mjs');

invalidateSkillsCache(root);

test.after(async () => {
  await settleSessionSummaryIndex();
  await (await import('./store/lifecycle-barriers.mjs')).flushSessionCloseMetrics();
  invalidateSkillsCache(root);
  rmSync(root, { recursive: true, force: true });
});

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

// The persisted transcript as a restarted app sees it: the session file on
// disk, restored into desktop/TUI rows.
function restoredUserRows(session) {
  const disk = JSON.parse(readFileSync(join(root, 'sessions', `${session.id}.json`), 'utf8'));
  return restoreTranscriptItems(disk.messages).filter((item) => item.kind === 'user');
}

// One ask turn the way prepareAskTurn/runAskAgentLoop drive it.
async function runAskTurn(session, prompt) {
  const userMessage = { role: 'user', content: prompt, meta: { transcript: { messageId: 'msg_turn' } } };
  const outgoing = [...session.messages, userMessage];
  const beforeCount = outgoing.length;
  session.messages = outgoing.slice();
  await saveSessionAsync(session); // preflight user-turn save
  const applied = await prepareExplicitSkills(prompt, outgoing, session, { cwd: root });
  recordAppliedSkills(outgoing, outgoing[beforeCount - 1], applied);
  session.messages = outgoing.slice();
  outgoing.push({ role: 'assistant', content: 'Done.' });
  session.messages = outgoing.slice(); // turn commit
  await saveSessionAsync(session);
  return applied;
}

test('inline $mentions on an ask turn survive save, reload from disk and restore', async () => {
  const session = newSession();
  const applied = await runAskTurn(session, 'Review with $selected-guide then $other-guide and $HOME.');
  assert.deepEqual(applied, ['selected-guide', 'other-guide']);
  const rows = restoredUserRows(session);
  const turn = rows.find((row) => row.messageId === 'msg_turn');
  assert.deepEqual(turn.appliedSkills, ['selected-guide', 'other-guide']);
  assert.equal(rows.find((row) => row.messageId === 'msg_earlier').appliedSkills, undefined);
});

test('a header-only selection survives save, reload from disk and restore', async () => {
  const session = newSession();
  await runAskTurn(session, `${skillSelectionHeader('selected-guide')}Do the work.`);
  const turn = restoredUserRows(session).find((row) => row.messageId === 'msg_turn');
  assert.deepEqual(turn.appliedSkills, ['selected-guide']);
});

test('a queued prompt mention survives save, reload from disk and restore', async () => {
  const session = newSession();
  const outgoing = [...session.messages, { role: 'user', content: 'First task' }];
  session.messages = outgoing.slice();
  await saveSessionAsync(session);
  let sends = 0;
  let drained = false;
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
      drainSteering() {
        if (sends !== 1 || drained) return [];
        drained = true;
        return [{ mode: 'prompt', content: 'Next: use $other-guide.', transcriptMeta: { messageId: 'msg_queued' } }];
      },
    }
  );
  session.messages = outgoing.slice();
  await saveSessionAsync(session);
  const queued = restoredUserRows(session).find((row) => row.messageId === 'msg_queued');
  assert.ok(queued, 'the queued prompt was persisted');
  assert.deepEqual(queued.appliedSkills, ['other-guide']);
});
