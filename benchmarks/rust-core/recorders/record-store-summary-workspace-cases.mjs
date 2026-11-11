#!/usr/bin/env node
// Recording of session/store-summary-workspace.test.mjs (b6f10295a): the session summary row's workspace field. Real
// store-summary-fields.mjs workspaceSummary and store-summary-index.mjs (_sessionSummary, _normalizeSummaryIndex), inputs as the test built them.
//
//   node benchmarks/rust-core/recorders/record-store-summary-workspace-cases.mjs --tree <export of b6f10295a with node_modules>
import { openSet } from './lib/case-set.mjs';

const set = openSet('store-summary-workspace-cases', import.meta.url);
const S = 'src/runtime/agent/orchestrator/session/';
const { _normalizeSummaryIndex, _sessionSummary } = await set.load(`${S}store-summary-index.mjs`);
const { workspaceSummary } = await set.load(`${S}store-summary-fields.mjs`);

const WORKTREE = 'C:/data/worktrees-v1/0123456789abcdef/fix-login';
const workspace = { projectPath: 'C:/repo', repoCommonDir: 'C:/repo/.git', cwd: WORKTREE, worktreeId: 'fix-login', branch: 'mixdog/fix-login', baseCommit: null, mergeTarget: 'main', revision: 3, transition: { state: 'idle', txId: null } };
const session = (extra = {}) => ({ id: 'sess_ws', createdAt: 1_000, updatedAt: 2_000, lastUsedAt: 2_000, status: 'idle', owner: 'user', cwd: WORKTREE, desktopSession: { classification: 'project', projectPath: 'C:/repo' }, messages: [{ role: 'user', content: 'prompt' }], ...extra });

await set.run('workspaceSummary carries the whole workspace record and requires both paths', () => {
  const inputs = [workspace, { projectPath: ' C:/repo ', cwd: 'C:/repo' }, { projectPath: 'C:/repo', cwd: 'C:/repo', revision: -1, transition: { state: 'bogus' } }, null, 'x', {}, { projectPath: 'C:/repo' }, { cwd: 'C:/repo' }, { projectPath: 'a\0', cwd: 'b' }];
  return { results: inputs.map((input) => ({ input, result: workspaceSummary(input) })) };
});
await set.run('summary rows expose the workspace while grouping stays on the project', () => {
  const input = session({ workspace });
  const summary = _sessionSummary(input);
  const [normalized] = _normalizeSummaryIndex({ rows: [summary] }).rows;
  return { session: input, summary, normalizedWorkspace: normalized.workspace, normalizedRow: normalized };
});
await set.run('a session without a workspace record has no workspace field', () => {
  const summary = _sessionSummary(session());
  return { session: session(), summary, hasWorkspaceKey: 'workspace' in summary };
});

await set.finish({
  entry: { runs: 'store-summary-fields.mjs workspaceSummary; store-summary-index.mjs _sessionSummary and _normalizeSummaryIndex', notRun: 'no session store: pure functions on the recorded session documents' },
  replay: { entry: 'mixdog-store summary.rs workspace_summary (and the summary row builder/normaliser): compare each result whole', normalised: {} },
});
process.exit(0);
