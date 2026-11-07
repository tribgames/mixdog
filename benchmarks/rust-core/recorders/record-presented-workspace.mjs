#!/usr/bin/env node
// Golden twin of `presentedWorkspace` (prompt-utils.mjs): what the session's prompt presents as
// the workspace, read back from `bp3EnvironmentContext`, `bp3CoreContext` / the `tier3` message and
// the `env` message (`mixdog-core-session` `presented_workspace`, `mixdog-core`
// `presented_workspace_of`).
//
// The function is not exported, so it is observed through its one caller: a workspace change on a
// session with a conversation (`refreshSessionWorkspaceContext` -> `stageWorkspaceReroot`) stores
// `presentedWorkspace(session)` as `workspaceReroot.seen`. Every session is built from Node's own
// helpers (`replaceWorkspaceCoreSlices`, `refreshSessionBp3Environment`). The run uses temp data,
// home, app-data and backup folders and its own git repository as the working folder.
//
//   node benchmarks/rust-core/recorders/record-presented-workspace.mjs --tree <dir>
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FIXTURES_ROOT, commitStage, importFrom, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } from './lib/common.mjs';

const cli = parseArgs();
const tree = resolveTree(cli);
const outDir = cli.get('out') ?? join(FIXTURES_ROOT, 'prompt-presented');
const stage = stageSet(outDir);

// Every user directory is a fresh temp folder before any Mixdog module is imported.
const work = mkdtempSync(join(tmpdir(), 'presented-work-'));
const dir = (name) => {
  const path = join(work, name);
  mkdirSync(path, { recursive: true });
  return path;
};
const data = dir('data');
const repo = dir('repo');
const home = dir('home');
execFileSync('git', ['init', '-q', repo]);
writeFileSync(join(repo, 'README.md'), '# repo\n');
process.env.MIXDOG_DATA_DIR = data;
process.env.MIXDOG_HOME = home;
process.env.MIXDOG_BACKUP_DIR = dir('backup');
process.env.MIXDOG_SKIP_USER_DATA_BACKUP = '1';
process.env.MIXDOG_CONFIG_READ_TTL_MS = '0';
process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.APPDATA = dir('appdata');
process.env.LOCALAPPDATA = dir('localappdata');

const utils = await importFrom(tree, 'src/runtime/agent/orchestrator/session/manager/prompt-utils.mjs');

const SEP = '\n\n---\n\n';
const clone = (value) => JSON.parse(JSON.stringify(value));
const INSTRUCTIONS = '# Instruction Files\n\n## C:/work/AGENTS.md\n\nBe careful.\n\n---\n\n## C:/work/proj/CLAUDE.md\n\nUse tabs.';
const MEMORY = 'Name: Sam\n\nLikes tea.';
const HEAD = '# Active Workflow: Coding\n\nWork in small steps.';
const facts = (cwd) => `- Cwd: ${cwd} — the active Project root; relative paths and shell commands resolve here.\n- Shell: PowerShell.\n- Git startup state: clean.`;
const LANGUAGE = '# Language\n\nReply in Korean.';
const OTHER = join(work, 'other');

const BASE = { role: 'system', content: '# Rules\n\nBase rules.' };
const STABLE = { role: 'system', content: '# Meta\n\nStable.' };

// `core`: the BP3 core; `tail`: bp3EnvironmentContext; `refresh`: whether Node's refresh runs, which
// writes the `env` message (split) or folds the Session block into the one message (combined).
function build({ name, split = true, owner = 'cli', core, tail, refresh = true, refreshCwd = repo, tier3 = true, model = 'gpt-5.5-2026-01-02' }) {
  const session = { id: `sess_${name}`, owner, cwd: repo, model, bp3CoreContext: core, messages: [clone(BASE), clone(STABLE)] };
  if (split) session.bp3EnvSplit = true;
  if (tail !== undefined) session.bp3EnvironmentContext = tail;
  if (tier3) session.messages.push({ role: 'system', content: core, cacheTier: 'tier3' });
  if (refresh) utils.refreshSessionBp3Environment(session, refreshCwd);
  return session;
}

const present = (session) => {
  const staged = clone(session);
  staged.messages.push({ role: 'user', content: 'hello' }, { role: 'assistant', content: 'hi' });
  utils.refreshSessionWorkspaceContext(staged, { cwd: OTHER });
  return staged.workspaceReroot.seen;
};

const slices = (head, o = {}) => utils.replaceWorkspaceCoreSlices(head, { coreMemoryContext: o.memory, instructionFilesContext: o.instructions });

const CASES = [
  build({ name: 'split-full', core: slices(HEAD, { memory: MEMORY, instructions: INSTRUCTIONS }), tail: [facts(repo), LANGUAGE].join(SEP) }),
  build({ name: 'combined-full', split: false, core: slices(HEAD, { memory: MEMORY, instructions: INSTRUCTIONS }), tail: [facts(repo), LANGUAGE].join(SEP) }),
  build({ name: 'split-session-cwd-wins', core: slices(HEAD, { memory: MEMORY }), tail: facts(repo), refreshCwd: join(work, 'rooted') }),
  build({ name: 'split-not-refreshed-worker-cwd', core: slices(HEAD, { instructions: INSTRUCTIONS }), tail: facts(repo), refresh: false }),
  build({ name: 'legacy-core-order', core: [HEAD, `# Core Memory\n${MEMORY}`, INSTRUCTIONS].join(SEP), tail: facts(repo) }),
  build({ name: 'tail-without-facts', core: slices(HEAD, { memory: MEMORY }), tail: LANGUAGE }),
  build({ name: 'agent-owner-no-session-block', owner: 'agent', core: HEAD, tail: '- Shell: Bash.', refresh: true }),
  build({ name: 'no-tail', core: slices(HEAD, { memory: MEMORY }), tail: undefined }),
  build({ name: 'no-tier3-message', core: slices(HEAD, { memory: MEMORY }), tail: facts(repo), tier3: false }),
  build({ name: 'spaced-facts-cwd', owner: 'agent', core: HEAD, tail: `- Cwd:   ${repo}  — the active Project root; relative paths and shell commands resolve here.\n- Shell: Bash.`, refresh: false }),
  build({ name: 'empty-memory-heading', core: [HEAD, '# Core Memory\n'].join(SEP), tail: facts(repo) }),
  build({ name: 'combined-not-refreshed', split: false, core: slices(HEAD, { memory: MEMORY, instructions: INSTRUCTIONS }), tail: facts(repo), refresh: false }),
].map((session) => ({
  name: session.id.slice('sess_'.length),
  header: Object.fromEntries(['owner', 'cwd', 'model', 'bp3EnvSplit', 'bp3CoreContext', 'bp3EnvironmentContext'].filter((k) => session[k] !== undefined).map((k) => [k, session[k]])),
  messages: session.messages,
  presented: present(session),
}));

let text = JSON.stringify({ cases: CASES });
const escaped = (s) => s.replaceAll('\\', '\\\\');
for (const variant of [escaped(work), work, work.replaceAll('\\', '/')]) text = text.split(variant).join('{WORK}');
writeJson(join(stage, 'presented.json'), JSON.parse(text));
writeSetManifest(stage, {
  set: 'prompt-presented',
  recorder: 'benchmarks/rust-core/recorders/record-presented-workspace.mjs',
  command: 'node benchmarks/rust-core/recorders/record-presented-workspace.mjs --tree <tree>',
  identityTree: tree,
});
commitStage(stage, outDir);
console.log(`prompt-presented: ${CASES.length} cases -> ${outDir}`);
