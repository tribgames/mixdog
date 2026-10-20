// The heir of a worktree-bound source starts in the Project folder: its
// prompt is re-rooted there, never at the source's worktree or at the
// source's staged (pending) workspace change.
import '../../../scripts/lib/isolated-test-env.mjs';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const root = mkdtempSync(join(tmpdir(), 'mixdog-cold-heir-'));
process.env.MIXDOG_DATA_DIR = join(root, 'data');
mkdirSync(process.env.MIXDOG_DATA_DIR, { recursive: true });
writeFileSync(
  join(process.env.MIXDOG_DATA_DIR, 'mixdog-config.json'),
  JSON.stringify({ agent: { instructionFiles: 'agents' } })
);
delete process.env.MIXDOG_BOOT_INSTRUCTION_FILES;
const { buildColdHeir } = await import('./cold-heir.mjs');
process.on('exit', () => rmSync(root, { recursive: true, force: true }));

const SEP = '\n\n---\n\n';
const tier = (session, cacheTier) =>
  session.messages.find((message) => message.role === 'system' && message.cacheTier === cacheTier).content;

test('the heir of a worktree source drops its pending re-root and is rooted at the Project folder', () => {
  const project = join(root, 'project');
  const worktree = join(root, 'worktrees', 'fix');
  mkdirSync(project, { recursive: true });
  mkdirSync(worktree, { recursive: true });
  writeFileSync(join(project, 'AGENTS.md'), 'project rule');
  writeFileSync(join(worktree, 'AGENTS.md'), 'worktree rule');
  const oldCore = `# Role${SEP}# Core Memory\n- old memo${SEP}# Instruction Files\n\n## C:/old/AGENTS.md\n\nold rule`;
  const oldEnv = '- Cwd: C:/old — the active Project root; relative paths and shell commands resolve here.';
  const source = {
    id: 'sess_source',
    owner: 'cli',
    cwd: worktree,
    bp3EnvSplit: true,
    bp3CoreContext: oldCore,
    bp3EnvironmentContext: oldEnv,
    workspace: {
      projectPath: project,
      repoCommonDir: join(project, '.git'),
      cwd: worktree,
      worktreeId: 'fix',
      branch: 'mixdog/fix',
      baseCommit: 'a'.repeat(40),
      mergeTarget: 'main',
      revision: 2,
      transition: { state: 'idle', txId: null },
    },
    // The source moved into its worktree mid-conversation: prompt still at C:/old.
    workspaceReroot: {
      version: 1,
      revision: 1,
      rootCwd: 'C:/old',
      seen: { cwd: 'C:/old' },
      target: {
        cwd: worktree,
        environmentContext: `- Cwd: ${worktree} — worktree facts`,
        coreMemoryContext: '- project memo',
        instructionFilesContext: '# Instruction Files\n\nworktree rule',
      },
    },
    messages: [
      { role: 'system', content: 'Preserve instructions.' },
      { role: 'system', content: oldCore, cacheTier: 'tier3' },
      { role: 'system', content: `# Session\nCwd: C:/old${SEP}${oldEnv}`, cacheTier: 'env' },
      { role: 'user', content: 'question' },
      { role: 'assistant', content: 'answer' },
    ],
  };
  const before = JSON.stringify(source);
  const heir = buildColdHeir(source);
  assert.equal(JSON.stringify(source), before, 'the source is never mutated');
  assert.equal(heir.cwd, project);
  assert.equal(Object.hasOwn(heir, 'workspaceReroot'), false, 'the pending re-root stays with the source');
  const core = tier(heir, 'tier3');
  assert.match(core, /project rule/);
  assert.match(core, /# Core Memory\n- project memo/);
  assert.doesNotMatch(core, /worktree rule|old rule|old memo/);
  assert.equal(heir.bp3CoreContext, core);
  const env = tier(heir, 'env');
  assert.ok(env.startsWith('- '), 'the Project folder facts lead the environment');
  assert.doesNotMatch(env, /C:\/old|worktree facts|worktrees|# Session/, 'the first turn stamps # Session');
  assert.equal(heir.sessionStartMetaInjected, false);
});
