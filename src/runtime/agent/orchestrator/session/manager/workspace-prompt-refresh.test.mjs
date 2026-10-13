// A workspace change re-roots an existing session's prompt in place: the
// environment facts, project memory and instruction files of the old root are
// replaced (never accumulated), the `# Session` Cwd follows, the response
// language block and the conversation are kept.
import assert from 'node:assert/strict';
import test from 'node:test';
import { composeSystemPrompt } from '../../context/role-instructions.mjs';
import {
  refreshSessionBp3Environment,
  refreshSessionWorkspaceContext,
  replaceWorkspaceCoreSlices,
} from './prompt-utils.mjs';

const SEP = '\n\n---\n\n';
const LANGUAGE = '# Language\n\n- Always respond in Korean.';

function sessionFor(cwd, { split = true } = {}) {
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
  const conversation = [
    { role: 'user', content: 'question' },
    { role: 'assistant', content: 'answer' },
  ];
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

test('a workspace refresh replaces memory, instruction files and environment facts in place', () => {
  const { session, conversation } = sessionFor('C:/repo');
  const next = {
    cwd: 'C:/data/worktrees-v1/abc/fix',
    environmentContext: '- Relative paths resolve in the active Project.\n- Git startup state: repository root C:/data/worktrees-v1/abc/fix on branch mixdog/fix.',
    coreMemoryContext: '- worktree memo',
    instructionFilesContext: '# Instruction Files\n\n## C:/data/worktrees-v1/abc/fix/AGENTS.md\n\nnew rule',
  };
  for (let round = 0; round < 2; round += 1) {
    assert.equal(refreshSessionWorkspaceContext(session, next), true);
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
  assert.deepEqual(session.messages.slice(-2), conversation, 'conversation history is kept');
});

test('a same-folder branch change refreshes facts and drops memory/instruction slices that no longer apply', () => {
  const { session } = sessionFor('C:/repo');
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

  const { session } = sessionFor('C:/repo', { split: false });
  refreshSessionWorkspaceContext(session, {
    cwd: 'C:/wt',
    environmentContext: '- Git startup state: repository root C:/wt on branch fix.',
    coreMemoryContext: '- wt memo',
    instructionFilesContext: '',
  });
  const legacy = tier(session, 'tier3');
  assert.ok(legacy.startsWith(`# Active Workflow: Solo${SEP}# General${SEP}# Core Memory\n- wt memo${SEP}# Session\nCwd: C:/wt`));
  assert.doesNotMatch(legacy, /Instruction Files|old project memo|C:\/repo/);
});
