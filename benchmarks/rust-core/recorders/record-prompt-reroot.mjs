#!/usr/bin/env node
// Golden of the in-place prompt re-root of a session without a conversation
// (`native/core/fixtures/prompt-reroot/golden.json`): Node's real
// `refreshSessionWorkspaceContext(session, context)` (prompt-utils.mjs: no user conversation, so
// `applyPendingWorkspaceReroot` then `rerootSessionWorkspace`), as `refreshWorkspacePrompt`
// (session-runtime/workspace/transitions.mjs) calls it on a workspace change. Each case: the
// prompt state before (the header fields the prompt lives in and the `tier3` / `env` system
// messages), the context, what the call answered, and the state after. The transition's undo
// (`snapshotPrompt`, transition-steps.mjs) restores the `before` state exactly.
//
//   node <repo>/benchmarks/rust-core/recorders/record-prompt-reroot.mjs --tree <tree>
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { FIXTURES_ROOT, parseArgs, resolveTree, writeJson, writeSetManifest } from './lib/common.mjs';

const repo = resolveTree(parseArgs());
const sandbox = mkdtempSync(join(tmpdir(), 'prompt-reroot-'));
// Every user directory the product reads is a fresh temp directory before any Mixdog module loads.
for (const key of ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'MIXDOG_HOME', 'MIXDOG_DATA_DIR', 'MIXDOG_CONFIG_DIR', 'MIXDOG_RUNTIME_ROOT', 'MIXDOG_USER_DATA_BACKUP_ROOT', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR']) {
  mkdirSync(join(sandbox, key));
  process.env[key] = join(sandbox, key);
}
delete process.env.MIXDOG_OWNER_SESSION_ID;
const at = (p) => import(pathToFileURL(join(repo, p)).href);

const { composeSystemPrompt } = await at('src/runtime/agent/orchestrator/context/role-instructions.mjs');
const { refreshSessionBp3Environment, refreshSessionWorkspaceContext } = await at(
  'src/runtime/agent/orchestrator/session/manager/prompt-utils.mjs'
);

const SEP = '\n\n---\n\n';
const LANGUAGE = '# Language\n\n- Always respond in Korean.';
const WORKTREE = 'C:/data/worktrees-v1/abc/fix';
const OTHER = 'C:/other';
const facts = (cwd, branch) => `- Relative paths resolve in the active Project.\n- Git startup state: repository root ${cwd} on branch ${branch}.`;
const FULL = {
  cwd: WORKTREE,
  environmentContext: facts(WORKTREE, 'mixdog/fix'),
  coreMemoryContext: '- worktree memo',
  instructionFilesContext: `# Instruction Files\n\n## ${WORKTREE}/AGENTS.md\n\nnew rule`,
};

/** A session's prompt as Node builds it; `conversation` adds a user turn, `refreshed: false`
 *  leaves it before its first `# Session` refresh (no `env` message yet). */
function sessionFor(cwd, { split = true, model = 'gpt-5.4-2026-01-02', owner = 'lead', refreshed = true, tail = true, conversation = false } = {}) {
  const composed = composeSystemPrompt({
    workflowContext: '# Active Workflow: Solo',
    roleRules: '# General',
    coreMemoryContext: '- old project memo',
    instructionFilesContext: `# Instruction Files\n\n## ${cwd}/AGENTS.md\n\nold rule${SEP}with a divider`,
    environmentContext: facts(cwd, 'main'),
    languageContext: LANGUAGE,
    skipRoleCatalog: true,
  });
  const session = {
    id: 's',
    owner,
    model,
    cwd,
    bp3CoreContext: composed.sessionMarkerCore,
    bp3EnvSplit: split,
    messages: [
      { role: 'system', content: 'rules' },
      { role: 'system', content: split ? composed.sessionMarkerCore : '', cacheTier: 'tier3' },
      ...(conversation ? [{ role: 'user', content: 'question' }, { role: 'assistant', content: 'answer' }] : []),
    ],
  };
  if (tail) session.bp3EnvironmentContext = [facts(cwd, 'main'), LANGUAGE].join(SEP);
  if (refreshed) refreshSessionBp3Environment(session, cwd);
  return session;
}

const HEADER_KEYS = ['owner', 'model', 'cwd', 'bp3CoreContext', 'bp3EnvironmentContext', 'bp3EnvSplit', 'sessionStartMetaInjected', 'workspaceReroot'];
const tier = (session, cacheTier) => session.messages.find((m) => m.cacheTier === cacheTier)?.content ?? null;
const state = (session) =>
  JSON.parse(
    JSON.stringify({
      header: Object.fromEntries(HEADER_KEYS.filter((key) => session[key] !== undefined).map((key) => [key, session[key]])),
      tier3: tier(session, 'tier3'),
      env: tier(session, 'env'),
      systemOnly: session.messages.every((m) => m.role === 'system'),
    })
  );

/** A change staged while the session had a conversation, then the conversation dropped. */
function staged(options) {
  const session = sessionFor('C:/repo', { ...options, conversation: true });
  session.cwd = OTHER;
  refreshSessionWorkspaceContext(session, { cwd: OTHER, environmentContext: facts(OTHER, 'dev'), coreMemoryContext: '- other memo' });
  session.messages = session.messages.filter((m) => m.role === 'system');
  return session;
}

const scenarios = [
  ['split, full change', () => sessionFor('C:/repo'), FULL],
  ['legacy, full change', () => sessionFor('C:/repo', { split: false }), FULL],
  ['split, cwd only', () => sessionFor('C:/repo'), { cwd: WORKTREE }],
  ['split, slices dropped', () => sessionFor('C:/repo'), { cwd: WORKTREE, environmentContext: '', coreMemoryContext: '', instructionFilesContext: '' }],
  // Workers never carry project memory: `refreshWorkspacePrompt` passes none for them.
  ['agent owner', () => sessionFor('C:/repo', { owner: 'agent' }), { ...FULL, coreMemoryContext: undefined }],
  ['before the first refresh', () => sessionFor('C:/repo', { refreshed: false }), FULL],
  ['legacy before the first refresh', () => sessionFor('C:/repo', { split: false, refreshed: false }), FULL],
  ['no environment tail', () => sessionFor('C:/repo', { tail: false, refreshed: false }), FULL],
  ['split, staged change applied first', () => staged({}), FULL],
  ['legacy, staged change applied first', () => staged({ split: false }), { cwd: WORKTREE, instructionFilesContext: FULL.instructionFilesContext }],
  ['model without date', () => sessionFor('C:/repo', { model: 'claude-opus-4-1' }), { cwd: WORKTREE }],
];

const cases = scenarios.map(([name, build, context]) => {
  const session = build();
  // The transition moves the session's own cwd before it refreshes the prompt.
  session.cwd = context.cwd;
  const before = state(session);
  const answered = refreshSessionWorkspaceContext(session, context);
  return { name, context: JSON.parse(JSON.stringify(context)), before, answered, after: state(session) };
});

rmSync(sandbox, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
const set = join(FIXTURES_ROOT, 'prompt-reroot');
writeJson(join(set, 'golden.json'), { cases });
writeSetManifest(set, {
  set: 'prompt-reroot',
  recorder: 'benchmarks/rust-core/recorders/record-prompt-reroot.mjs',
  command: 'node <repo>/benchmarks/rust-core/recorders/record-prompt-reroot.mjs --tree <tree>',
  identityTree: repo,
});
console.log(`recorded ${cases.length} cases`);
process.exit(0);
