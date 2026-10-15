// A workspace change of a session with a conversation keeps every system
// message byte-identical (provider prompt cache intact) and tells the model
// through one tail notice on its next user turn; the next re-root (compaction,
// route change, cleared conversation) rewrites the prompt and retires the
// notice. A session without a conversation is re-rooted in place: the
// environment facts, project memory and instruction files of the old root are
// replaced (never accumulated), the `# Session` Cwd follows, the response
// language block is kept.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { composeSystemPrompt } from '../../context/role-instructions.mjs';
import { buildUserTurn } from './ask-turn-prepare.mjs';
import {
  acknowledgePendingWorkspaceNotice,
  applyPendingWorkspaceReroot,
  refreshSessionBp3Environment,
  refreshSessionWorkspaceContext,
  replaceWorkspaceCoreSlices,
  resetSessionBp3Environment,
  snapshotPendingWorkspaceNotice,
} from './prompt-utils.mjs';

const SEP = '\n\n---\n\n';
const LANGUAGE = '# Language\n\n- Always respond in Korean.';

const WORKTREE = 'C:/data/worktrees-v1/abc/fix';
const NEXT = {
  cwd: WORKTREE,
  environmentContext: `- Relative paths resolve in the active Project.\n- Git startup state: repository root ${WORKTREE} on branch mixdog/fix.`,
  coreMemoryContext: '- worktree memo',
  instructionFilesContext: `# Instruction Files\n\n## ${WORKTREE}/AGENTS.md\n\nnew rule`,
};

function sessionFor(cwd, { split = true, conversation: withConversation = true } = {}) {
  const composed = composeSystemPrompt({
    workflowContext: '# Active Workflow: Solo',
    roleRules: '# General',
    coreMemoryContext: '- old project memo',
    instructionFilesContext: `# Instruction Files\n\n## ${cwd}/AGENTS.md\n\nold rule${SEP}with a divider`,
    environmentContext: `- Relative paths resolve in the active Project.\n- Git startup state: repository root ${cwd} on branch main.`,
    languageContext: LANGUAGE,
    skipRoleCatalog: true,
  });
  const environmentTail = [
    `- Relative paths resolve in the active Project.\n- Git startup state: repository root ${cwd} on branch main.`,
    LANGUAGE,
  ].join(SEP);
  const conversation = withConversation
    ? [
        { role: 'user', content: 'question' },
        { role: 'assistant', content: 'answer' },
      ]
    : [];
  const session = {
    id: 's',
    model: 'claude-x',
    cwd,
    bp3CoreContext: composed.sessionMarkerCore,
    bp3EnvironmentContext: environmentTail,
    bp3EnvSplit: split,
    messages: split
      ? [
          { role: 'system', content: 'rules' },
          { role: 'system', content: composed.sessionMarkerCore, cacheTier: 'tier3' },
          ...conversation,
        ]
      : [{ role: 'system', content: 'rules' }, { role: 'system', content: '', cacheTier: 'tier3' }, ...conversation],
  };
  refreshSessionBp3Environment(session, cwd);
  return { session, conversation };
}

const tier = (session, cacheTier) => session.messages.find((message) => message.cacheTier === cacheTier)?.content;
const systemOf = (session) => session.messages.filter((message) => message.role === 'system');
const promptState = (session) =>
  JSON.stringify({
    system: systemOf(session),
    core: session.bp3CoreContext,
    env: session.bp3EnvironmentContext,
    injected: session.sessionStartMetaInjected,
  });

const FULL_NOTICE = [
  '<system-reminder>',
  '# Working Folder Changed',
  `The working folder is now ${WORKTREE}. This replaces the Cwd and environment facts given earlier in this conversation; relative paths and shell commands resolve here.`,
  NEXT.environmentContext,
  '',
  'The instruction files below replace all previously provided instruction files.',
  '',
  NEXT.instructionFilesContext,
  '',
  'The core memory below replaces all previously provided core memory.',
  '',
  '# Core Memory',
  '- worktree memo',
  '</system-reminder>',
].join('\n');

test('a mid-conversation folder change keeps every system message byte-identical and stages one tail notice', () => {
  const { session, conversation } = sessionFor('C:/repo');
  const before = promptState(session);
  const references = systemOf(session);
  assert.equal(refreshSessionWorkspaceContext(session, NEXT), true);
  assert.equal(promptState(session), before, 'system messages and prompt fields are untouched');
  assert.deepEqual(systemOf(session), references);
  systemOf(session).forEach((message, index) => assert.equal(message, references[index], 'same message objects'));
  assert.deepEqual(session.messages.slice(-2), conversation, 'no message is added to the transcript');
  assert.equal(snapshotPendingWorkspaceNotice(session).content, FULL_NOTICE);
  // An ordinary `# Session` refresh (a same-route update) keeps the old root too.
  refreshSessionBp3Environment(session, WORKTREE);
  assert.equal(promptState(session), before);
});

test('removed instruction files and memory are announced as no longer applying; unchanged slices are omitted', () => {
  const { session } = sessionFor('C:/repo');
  refreshSessionWorkspaceContext(session, { cwd: 'C:/plain', coreMemoryContext: '', instructionFilesContext: '' });
  const removed = snapshotPendingWorkspaceNotice(session).content;
  assert.match(
    removed,
    /The new working folder has no instruction files: the previously provided instruction files no longer apply\./
  );
  assert.match(removed, /The new working folder has no core memory: the previously provided core memory no longer applies\./);
  assert.doesNotMatch(removed, /old rule|old project memo/);

  const { session: same } = sessionFor('C:/repo');
  const presented = tier(same, 'tier3');
  refreshSessionWorkspaceContext(same, {
    cwd: 'C:/elsewhere',
    coreMemoryContext: '- old project memo',
    instructionFilesContext: presented.slice(presented.indexOf('# Instruction Files')),
  });
  const folderOnly = snapshotPendingWorkspaceNotice(same).content;
  assert.match(folderOnly, /^<system-reminder>\n# Working Folder Changed\nThe working folder is now C:\/elsewhere\./);
  assert.doesNotMatch(folderOnly, /instruction files|core memory/i);
});

test('no notice when the folder did not change; the new facts still wait for the next re-root', () => {
  const { session } = sessionFor('C:/repo');
  const before = promptState(session);
  refreshSessionWorkspaceContext(session, {
    cwd: 'C:/repo',
    environmentContext: '- Git startup state: repository root C:/repo on branch dev.',
    coreMemoryContext: '',
    instructionFilesContext: '',
  });
  assert.equal(snapshotPendingWorkspaceNotice(session), null);
  assert.equal(promptState(session), before);
  assert.equal(applyPendingWorkspaceReroot(session), true);
  assert.equal(tier(session, 'tier3'), ['# Active Workflow: Solo', '# General'].join(SEP));
  assert.match(tier(session, 'env'), /on branch dev\.[\s\S]*# Language/);

  const { session: back } = sessionFor('C:/repo');
  refreshSessionWorkspaceContext(back, NEXT);
  refreshSessionWorkspaceContext(back, { cwd: 'C:/repo' });
  assert.equal(snapshotPendingWorkspaceNotice(back), null, 'back where the model already is: nothing to say');
});

test('an acknowledged notice is not repeated; a later change compares with what the model was told', () => {
  const { session } = sessionFor('C:/repo');
  refreshSessionWorkspaceContext(session, NEXT);
  const notice = snapshotPendingWorkspaceNotice(session);
  assert.equal(acknowledgePendingWorkspaceNotice(session, notice.revision + 1), false, 'a stale revision is ignored');
  assert.equal(acknowledgePendingWorkspaceNotice(session, notice.revision), true);
  assert.equal(snapshotPendingWorkspaceNotice(session), null);
  refreshSessionWorkspaceContext(session, {
    cwd: 'C:/third',
    coreMemoryContext: '- worktree memo',
    instructionFilesContext: '# Instruction Files\n\n## C:/third/AGENTS.md\n\nthird rule',
  });
  const next = snapshotPendingWorkspaceNotice(session).content;
  assert.match(next, /now C:\/third\./);
  assert.match(next, /third rule/);
  assert.doesNotMatch(next, /core memory/i, 'the memory the model was told did not change');
});

test('the next user turn carries the notice as a trailing system-reminder after the human text', async (t) => {
  const previous = process.env.MIXDOG_DATA_DIR;
  const dataDir = mkdtempSync(join(tmpdir(), 'mixdog-workspace-notice-'));
  process.env.MIXDOG_DATA_DIR = dataDir;
  t.after(() => {
    if (previous === undefined) delete process.env.MIXDOG_DATA_DIR;
    else process.env.MIXDOG_DATA_DIR = previous;
    rmSync(dataDir, { recursive: true, force: true });
  });
  const { session } = sessionFor('C:/repo');
  session.contextWindow = 200_000;
  const before = promptState(session);
  refreshSessionWorkspaceContext(session, NEXT);
  const turn = await buildUserTurn({ session, prompt: 'continue' });
  assert.equal(turn.workspaceNotice.content, FULL_NOTICE);
  assert.equal(turn.userTurnMessage.role, 'user');
  assert.equal(turn.userTurnMessage.content, `continue\n\n${FULL_NOTICE}`);
  assert.deepEqual(
    turn.outgoing.map((message) => message.role),
    ['system', 'system', 'system', 'user', 'assistant', 'user'],
    'the notice rides the user turn: roles still alternate'
  );
  assert.equal(JSON.stringify(systemOf({ messages: turn.outgoing })), JSON.stringify(JSON.parse(before).system));
  acknowledgePendingWorkspaceNotice(session, turn.workspaceNotice.revision);
  const later = await buildUserTurn({ session, prompt: 'more' });
  assert.equal(later.workspaceNotice, null);
  assert.equal(later.userTurnMessage.content, 'more');
});

test('a re-root applies the staged workspace to the system prompt and retires the notice', () => {
  const { session, conversation } = sessionFor('C:/repo');
  refreshSessionWorkspaceContext(session, NEXT);
  const outgoing = [...session.messages, { role: 'user', content: 'turn' }];
  session.messages = session.messages.slice();
  assert.equal(applyPendingWorkspaceReroot(session, outgoing), true);
  assert.equal(session.workspaceReroot, undefined);
  assert.equal(snapshotPendingWorkspaceNotice(session), null);
  assert.equal(applyPendingWorkspaceReroot(session), false, 'nothing left to apply');
  for (const messages of [outgoing, session.messages]) {
    const view = { messages };
    assert.equal(
      tier(view, 'tier3'),
      ['# Active Workflow: Solo', '# General', '# Core Memory\n- worktree memo', NEXT.instructionFilesContext].join(SEP)
    );
    assert.match(tier(view, 'env'), new RegExp(`^# Session\\nCwd: ${WORKTREE}\\nModel: `));
    assert.doesNotMatch(tier(view, 'env'), /C:\/repo/);
    assert.ok(tier(view, 'env').endsWith(LANGUAGE));
  }
  assert.deepEqual(session.messages.slice(-2), conversation);

  const { session: cleared } = sessionFor('C:/repo');
  refreshSessionWorkspaceContext(cleared, NEXT);
  resetSessionBp3Environment(cleared);
  assert.equal(cleared.workspaceReroot, undefined, 'a cleared conversation re-roots instead of noticing');
  assert.match(tier(cleared, 'tier3'), /worktree memo/);
});

test('a session without a conversation is re-rooted in place', () => {
  const { session } = sessionFor('C:/repo', { conversation: false });
  for (let round = 0; round < 2; round += 1) {
    assert.equal(refreshSessionWorkspaceContext(session, NEXT), true);
    assert.equal(session.workspaceReroot, undefined);
    const core = tier(session, 'tier3');
    assert.equal(
      core,
      [
        '# Active Workflow: Solo',
        '# General',
        '# Core Memory\n- worktree memo',
        '# Instruction Files\n\n## C:/data/worktrees-v1/abc/fix/AGENTS.md\n\nnew rule',
      ].join(SEP),
      'superseded blocks are replaced, not accumulated'
    );
    assert.equal(session.bp3CoreContext, core);
    const env = tier(session, 'env');
    assert.match(env, /^# Session\nCwd: C:\/data\/worktrees-v1\/abc\/fix\nModel: /);
    assert.equal((env.match(/Git startup state/g) || []).length, 1);
    assert.match(env, /on branch mixdog\/fix\./);
    assert.doesNotMatch(env, /C:\/repo/);
    assert.ok(env.endsWith(LANGUAGE), 'the response language still closes the environment');
  }
  assert.ok(session.messages.every((message) => message.role === 'system'), 'no notice message is added');
});

test('a same-folder branch change refreshes facts and drops memory/instruction slices that no longer apply', () => {
  const { session } = sessionFor('C:/repo', { conversation: false });
  refreshSessionWorkspaceContext(session, {
    cwd: 'C:/repo',
    environmentContext: '- Git startup state: repository root C:/repo on branch dev.',
    coreMemoryContext: '',
    instructionFilesContext: '',
  });
  assert.equal(tier(session, 'tier3'), ['# Active Workflow: Solo', '# General'].join(SEP));
  assert.match(tier(session, 'env'), /on branch dev\.[\s\S]*# Language/);
  assert.doesNotMatch(tier(session, 'env'), /branch main/);
});

test('undefined slices are kept (workers keep their memory layout) and the legacy layout rebuilds tier3', () => {
  const kept = replaceWorkspaceCoreSlices(`# Role${SEP}# Core Memory\n- memo${SEP}# Instruction Files\n\nold`, {
    instructionFilesContext: '# Instruction Files\n\nnew',
  });
  assert.equal(kept, `# Role${SEP}# Core Memory\n- memo${SEP}# Instruction Files\n\nnew`);
  assert.equal(replaceWorkspaceCoreSlices('# Role', { coreMemoryContext: '- memo' }), `# Role${SEP}# Core Memory\n- memo`);

  const wt = {
    cwd: 'C:/wt',
    environmentContext: '- Git startup state: repository root C:/wt on branch fix.',
    coreMemoryContext: '- wt memo',
    instructionFilesContext: '',
  };
  const { session } = sessionFor('C:/repo', { split: false, conversation: false });
  refreshSessionWorkspaceContext(session, wt);
  const legacy = tier(session, 'tier3');
  assert.ok(legacy.startsWith(`# Active Workflow: Solo${SEP}# General${SEP}# Core Memory\n- wt memo${SEP}# Session\nCwd: C:/wt`));
  assert.doesNotMatch(legacy, /Instruction Files|old project memo|C:\/repo/);

  // Legacy layout with a conversation: untouched until the re-root, which
  // then produces the same prompt.
  const { session: talking } = sessionFor('C:/repo', { split: false });
  const before = promptState(talking);
  refreshSessionWorkspaceContext(talking, wt);
  assert.equal(promptState(talking), before);
  assert.match(snapshotPendingWorkspaceNotice(talking).content, /now C:\/wt\./);
  applyPendingWorkspaceReroot(talking);
  assert.equal(tier(talking, 'tier3'), legacy);
});
