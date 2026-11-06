// Records Node's pending workspace re-root on a route change (`updateSessionRoute`: when the route
// changed, `applyPendingWorkspaceReroot`, then `refreshSessionBp3Environment(session, session.cwd)`)
// into reroot_goldens.json, which `worktree_reroot.rs` compares the Rust port against.
//
//   node record_reroot.mjs [path-to-mixdog-node-checkout]   (default C:/Project/mixdog)
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = process.argv[2] ?? 'C:/Project/mixdog';
const load = (path) => import(pathToFileURL(`${ROOT}/${path}`).href);
const { composeSystemPrompt } = await load('src/runtime/agent/orchestrator/context/role-instructions.mjs');
const { applyPendingWorkspaceReroot, refreshSessionBp3Environment, refreshSessionWorkspaceContext } = await load(
  'src/runtime/agent/orchestrator/session/manager/prompt-utils.mjs'
);

const SEP = '\n\n---\n\n';
const LANGUAGE = '# Language\n\n- Always respond in Korean.';
const WORKTREE = 'C:/data/worktrees-v1/abc/fix';
const FULL = {
  cwd: WORKTREE,
  environmentContext: `- Relative paths resolve in the active Project.\n- Git startup state: repository root ${WORKTREE} on branch mixdog/fix.`,
  coreMemoryContext: '- worktree memo',
  instructionFilesContext: `# Instruction Files\n\n## ${WORKTREE}/AGENTS.md\n\nnew rule`,
  move: { from: 'C:/repo', changes: 'carried' },
};

function sessionFor(cwd, { split, model = 'gpt-5.4-2026-01-02', owner = 'lead' }) {
  const composed = composeSystemPrompt({
    workflowContext: '# Active Workflow: Solo',
    roleRules: '# General',
    coreMemoryContext: '- old project memo',
    instructionFilesContext: `# Instruction Files\n\n## ${cwd}/AGENTS.md\n\nold rule${SEP}with a divider`,
    environmentContext: `- Relative paths resolve in the active Project.\n- Git startup state: repository root ${cwd} on branch main.`,
    languageContext: LANGUAGE,
    skipRoleCatalog: true,
  });
  const session = {
    id: 's',
    owner,
    model,
    cwd,
    bp3CoreContext: composed.sessionMarkerCore,
    bp3EnvironmentContext: [
      `- Relative paths resolve in the active Project.\n- Git startup state: repository root ${cwd} on branch main.`,
      LANGUAGE,
    ].join(SEP),
    bp3EnvSplit: split,
    messages: [
      { role: 'system', content: 'rules' },
      { role: 'system', content: split ? composed.sessionMarkerCore : '', cacheTier: 'tier3' },
      { role: 'user', content: 'question' },
      { role: 'assistant', content: 'answer' },
    ],
  };
  refreshSessionBp3Environment(session, cwd);
  return session;
}

const tier = (session, cacheTier) => session.messages.find((m) => m.cacheTier === cacheTier)?.content ?? null;
const state = (session) => ({
  header: Object.fromEntries(
    ['owner', 'model', 'cwd', 'bp3CoreContext', 'bp3EnvironmentContext', 'bp3EnvSplit', 'sessionStartMetaInjected', 'workspaceReroot']
      .filter((key) => session[key] !== undefined)
      .map((key) => [key, session[key]])
  ),
  tier3: tier(session, 'tier3'),
  env: tier(session, 'env'),
});

const scenarios = [
  ['split, full change', { split: true }, FULL],
  ['legacy, full change', { split: false }, FULL],
  ['split, cwd only', { split: true }, { cwd: WORKTREE }],
  ['split, slices dropped', { split: true }, { cwd: WORKTREE, coreMemoryContext: '', instructionFilesContext: '' }],
  ['agent owner', { split: true, owner: 'agent' }, FULL],
  ['model without date', { split: true, model: 'claude-opus-4-1' }, { cwd: WORKTREE }],
];
const cases = [];
for (const [name, options, change] of scenarios) {
  // The workspace transition moves the session's own cwd before it stages the change.
  const staged = () => {
    const session = sessionFor('C:/repo', options);
    session.cwd = change.cwd;
    refreshSessionWorkspaceContext(session, change);
    return session;
  };
  const session = staged();
  const before = JSON.parse(JSON.stringify(state(session)));
  // A route change that did not change the route re-roots nothing; one that did applies the staged change.
  const stayed = staged();
  refreshSessionBp3Environment(stayed, stayed.cwd);
  applyPendingWorkspaceReroot(session);
  refreshSessionBp3Environment(session, session.cwd);
  cases.push({ name, before, applied: state(session), kept: state(stayed) });
}
const here = dirname(fileURLToPath(import.meta.url));
writeFileSync(join(here, 'reroot_goldens.json'), `${JSON.stringify(cases, null, 2)}\n`);
console.log(`recorded ${cases.length} scenarios`);
