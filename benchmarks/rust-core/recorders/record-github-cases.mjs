#!/usr/bin/env node
// Recording of runtime/github/github.test.mjs (b6f10295a): the github tool. Real contract.mjs (GITHUB_ACTIONS, githubRequestMutates,
// validateGithubRequest), commands.mjs (buildGithubCommand), client.mjs (executeGithubRequest: write queue, clone destination claim,
// abort, response checks), tool.mjs (executeGithubTool: model-facing projection, 10 KB cap, raw file) and the builtin registry's
// executeBuiltinTool('github'), with `gh` replaced by a scripted `run` (the test's own injection point). Per case: the inputs, the
// `gh` commands the module built (args, stdin, mutation flag) in order, and the result or the error text; a tool result's raw file is
// read back and recorded.
//
//   node benchmarks/rust-core/recorders/record-github-cases.mjs --tree <export of b6f10295a with node_modules>
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openSet } from './lib/case-set.mjs';

const set = openSet('github-cases', import.meta.url);
const { GITHUB_ACTIONS, githubRequestMutates, validateGithubRequest } = await set.load('src/runtime/github/contract.mjs');
const { buildGithubCommand } = await set.load('src/runtime/github/commands.mjs');
const { executeGithubRequest } = await set.load('src/runtime/github/client.mjs');
const { executeGithubTool } = await set.load('src/runtime/github/tool.mjs');
const { _isMutationTool } = await set.load('src/runtime/agent/orchestrator/session/loop/tool-classify.mjs');
const { executeBuiltinTool, isBuiltinTool } = await set.load('src/runtime/agent/orchestrator/tools/builtin.mjs');

const CWD = process.cwd();
const sha = 'a'.repeat(40);
const repo = 'owner/project';
const dirs = [];
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };
const tmpdirFor = async (prefix) => { const d = await mkdtemp(join(tmpdir(), prefix)); dirs.push(d); return d; };
const responseFor = (command) => { if (command.list) return JSON.stringify(command.collection ? { [command.collection]: [] } : []); return command.json ? JSON.stringify({ id: 42, number: 7, merged: true }) : 'done'; };
const cmdView = (c) => structuredClone(c);
/** executeGithubRequest with a scripted `run`; `answer(command, index)` returns the text (or throws). */
async function request(input, answer, options = {}) {
  const commands = [];
  const out = { input, commands };
  try {
    out.result = await executeGithubRequest(input, CWD, { ...options, run: async (command) => { commands.push(cmdView(command)); return answer(command, commands.length - 1); } });
  } catch (e) { out.error = e; }
  return out;
}
/** executeGithubTool with a scripted `run`; the raw file (when the result names one) is read back. */
async function tool(input, answer, options = {}) {
  const commands = [];
  const out = { input, commands };
  try {
    const text = await executeGithubTool(input, CWD, { ...options, run: async (command) => { commands.push(cmdView(command)); return answer(command, commands.length - 1); } });
    out.textBytes = Buffer.byteLength(text, 'utf8');
    out.text = text;
    let parsed = null;
    try { parsed = JSON.parse(text); } catch { /* an Error: text */ }
    if (parsed?.raw && typeof parsed.raw === 'string' && !/unavailable/.test(parsed.raw)) { try { out.rawFile = JSON.parse(await readFile(parsed.raw, 'utf8')); } catch (e) { out.rawFileError = e; } }
  } catch (e) { out.error = e; }
  return out;
}
const withDataDir = async (prefix, fn) => {
  const dataDir = await tmpdirFor(prefix);
  const previous = process.env.MIXDOG_DATA_DIR;
  process.env.MIXDOG_DATA_DIR = dataDir;
  try { return await fn(dataDir); } finally {
    if (previous === undefined) delete process.env.MIXDOG_DATA_DIR; else process.env.MIXDOG_DATA_DIR = previous;
    await rm(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
};

await set.run('every supported operation executes through a bounded, non-interactive request', async () => {
  const directory = await tmpdirFor('github-');
  const examples = {
    'repo.list': {}, 'repo.view': {}, 'repo.create': { visibility: 'private' }, 'repo.fork': {}, 'issue.list': {}, 'issue.view': { number: 7 }, 'issue.comments': { number: 7 },
    'issue.create': { title: '새 이슈', body: '설명' }, 'issue.edit': { number: 7, labels: ['bug'], assignees: ['owner'] }, 'issue.close': { number: 7 }, 'issue.reopen': { number: 7 }, 'issue.comment': { number: 7, body: '댓글' },
    'pr.list': {}, 'pr.view': { number: 7 }, 'pr.create': { title: 'PR', head: 'topic', base: 'main', draft: true }, 'pr.checkout': { number: 7 }, 'pr.merge': { number: 7, sha },
    'pr.review': { number: 7, sha, event: 'REQUEST_CHANGES', body: '수정 요청' }, 'pr.comment': { number: 7, body: '설명' }, 'pr.comments': { number: 7 },
    'workflow.list': {}, 'workflow.run': { workflow: 'test.yml', ref: 'main', inputs: { version: '1' } }, 'run.list': {}, 'run.view': { id: 42 }, 'run.logs': { id: 42, failed: true }, 'run.rerun': { id: 42, failed: true }, 'run.cancel': { id: 42 },
    'release.list': {}, 'release.view': { id: 42 }, 'release.create': { tag: 'v1.0', title: 'Version 1', draft: true }, 'release.edit': { id: 42, draft: false }, 'notification.list': {}, 'notification.read': { id: 42 },
  };
  examples['repo.clone'] = { destination: join(directory, 'new-repo') };
  const perAction = [];
  for (const [action, fields] of Object.entries(examples)) {
    const out = await request({ action, repo, ...fields }, (command) => responseFor(command));
    perAction.push({ ...out, mutatesByContract: githubRequestMutates({ action }), mutationToolByClassifier: _isMutationTool('github', { action }) });
  }
  return { repo, sha, actionsInContract: Object.keys(GITHUB_ACTIONS), actionsInExamples: Object.keys(examples), perAction };
});
await set.run('invalid requests cannot launch a process or smuggle API/CLI flags', async () => {
  const inputs = [
    { action: 'api', endpoint: 'user' }, { action: 'repo.view', repo: '--help/x' }, { action: 'repo.view', repo: 'https://github.com/owner/repo' }, { action: 'repo.view', repo: 'a/..' }, { action: 'repo.view', hostname: 'https://github.com' },
    { action: 'issue.create', repo, title: 'x', command: 'whoami' }, { action: 'issue.close', repo }, { action: 'issue.view', repo, number: '7' }, { action: 'issue.list', repo, limit: 101 }, { action: 'issue.create', repo, title: 'x', labels: ['ok', null] },
    { action: 'workflow.run', repo, workflow: 'test.yml', ref: '--help' }, { action: 'workflow.run', repo, workflow: 'test.yml', ref: 'main', inputs: { unsafe: 12 } }, { action: 'pr.merge', repo, number: 7 },
    { action: 'pr.review', repo, number: 7, sha, event: 'REQUEST_CHANGES', body: '' }, { action: 'repo.create', visibility: 'private' }, { action: 'repo.clone', repo, destination: '.' },
  ];
  const results = [];
  for (const input of inputs) results.push(await request(input, () => '{}'));
  return { results, processesLaunched: results.reduce((n, r) => n + r.commands.length, 0), mutatesUnknownAction: githubRequestMutates({ action: 'unknown' }) };
});
await set.run('Korean titles and shell-looking bodies remain JSON data', () => {
  const body = '`whoami`; $(Remove-Item x)\n한글 & 제목';
  const command = buildGithubCommand({ action: 'issue.create', repo, title: '--help', body });
  return { body, command: cmdView(command), inputParsed: JSON.parse(command.input) };
});
await set.run('workflow-filtered run lists execute once without a failed unfiltered request', async () => {
  const filtered = [];
  for (const workflow of ['build.yml', 'deploy.yml', 'release-projectaa.yml', '42']) filtered.push(await request({ action: 'run.list', repo, workflow, page: 2, limit: 3 }, () => JSON.stringify({ workflow_runs: [{ id: 42 }] })));
  let unsupported = null;
  try { validateGithubRequest({ action: 'run.list', repo, state: 'all' }); } catch (e) { unsupported = e; }
  return { filtered, unfilteredCommand: cmdView(buildGithubCommand({ action: 'run.list', repo })), unsupportedStateField: unsupported };
});
await set.run('repo inference binds the write to the resolved Project repository', async () => ({
  cwd: '<process cwd>', out: await request({ action: 'issue.create', title: 'Bound' }, (_c, i) => (i === 0 ? JSON.stringify({ nameWithOwner: repo }) : JSON.stringify({ number: 9 }))),
}));
await set.run('issues paginate on the original page even when it only contains pull requests', async () => ({
  out: await request({ action: 'issue.list', repo, page: 3, limit: 2 }, () => JSON.stringify([{ id: 1, pull_request: {} }, { id: 2, pull_request: {} }])),
}));
await set.run('writes serialize; a failed write is never replayed and does not poison the next call', async () => {
  const first = deferred(); const started = deferred(); const order = [];
  const run = async (command) => { const title = JSON.parse(command.input).title; order.push(title); if (title === 'first') { started.resolve(); await first.promise; throw new Error('connection lost'); } return '{"number":8}'; };
  const a = executeGithubRequest({ action: 'issue.create', repo, title: 'first' }, CWD, { run });
  const aOutcome = a.then((r) => ({ resolved: r }), (e) => ({ rejected: e }));
  await started.promise;
  const b = executeGithubRequest({ action: 'issue.create', repo, title: 'second' }, CWD, { run });
  const orderWhileFirstHeld = [...order];
  first.resolve();
  const aResult = await aOutcome;
  const bResult = await b;
  return { orderWhileFirstHeld, first: aResult, second: bResult, orderAfter: order };
});
await set.run('cancelled and existing-destination requests leave files and remote state untouched', async () => {
  const directory = await tmpdirFor('github-protected-');
  let calls = 0;
  const run = async () => { calls++; return ''; };
  const existing = await executeGithubRequest({ action: 'repo.clone', repo, destination: directory }, CWD, { run }).then(() => ({ resolved: true }), (e) => ({ rejected: e }));
  const controller = new AbortController();
  controller.abort();
  const cancelled = await executeGithubRequest({ action: 'issue.list', repo }, CWD, { run, abortSignal: controller.signal }).then(() => ({ resolved: true }), (e) => ({ rejected: e }));
  return { destination: directory, existing, cancelled, calls };
});
await set.run('merge refusal and unreadable write responses are errors, not successful actions', async () => ({
  refused: await request({ action: 'pr.merge', repo, number: 7, sha }, () => '{"merged":false,"message":"Head changed"}'),
  unreadable: await request({ action: 'issue.create', repo, title: 'X' }, () => 'not-json'),
}));
await set.run('the agent tool is registered and returns the ordinary builtin text/error contract', async () => {
  const value = await executeBuiltinTool('github', { action: 'repo.view', repo }, CWD, { run: async () => '{"full_name":"owner/project"}' });
  const unsupported = await executeGithubTool({ action: 'not-supported' }, CWD);
  const bounded = await executeGithubTool({ action: 'run.logs', repo, id: 42 }, CWD, { run: async () => '한'.repeat(100000) });
  return { isBuiltinTool: isBuiltinTool('github'), builtinValue: value, unsupported, bounded, boundedBytes: Buffer.byteLength(bounded, 'utf8') };
});
await set.run('model-facing results drop API-only fields, keep decision fields, and preserve the raw response', () => withDataDir('github-raw-', async () => {
  const user = (login, type = 'User') => ({ login, id: 1, node_id: 'U', type, avatar_url: 'a', followers_url: 'f' });
  const nested = { full_name: 'fork/project', id: 2, owner: user('fork'), forks_url: 'x', clone_url: 'c' };
  const pr = {
    id: 123, number: 7, title: 'Fix', state: 'open', body: 'details', node_id: 'PR', url: 'https://api.github.com/x', html_url: 'https://github.com/x', diff_url: 'd', comments_url: 'c', author_association: 'MEMBER', performed_via_github_app: null,
    reactions: { url: 'u', total_count: 0, '+1': 0 }, milestone: { id: 3, number: 2, title: 'M', url: 'u' }, user: user('alice'), assignees: [user('bob')], requested_reviewers: [user('ci', 'Bot')], labels: [{ name: 'bug', node_id: 'L' }],
    head: { sha, ref: 'feature', repo: nested, user: user('fork') }, base: { ref: 'main', repo: { ...nested, full_name: repo } }, commit: { author: { name: 'Alice', email: 'a@example.com' } }, _links: { self: 'x' },
  };
  const projected = await tool({ action: 'run.view', repo, id: 7 }, () => JSON.stringify(pr), { sessionId: 'sess_github_raw', toolCallId: 'call_1' });
  const repoView = await tool({ action: 'repo.view', repo }, () => JSON.stringify({ ...nested, full_name: repo }));
  const bodies = await tool({ action: 'pr.list', repo, limit: 2 }, () => JSON.stringify([1, 2].map((number) => ({ number, body: 'y'.repeat(20000) }))), { sessionId: 'sess_github_raw', toolCallId: 'call_bodies' });
  const page = Array.from({ length: 60 }, (_, index) => ({ number: index + 1, title: 't'.repeat(200) }));
  const listed = await tool({ action: 'issue.list', repo, limit: 60 }, () => JSON.stringify(page), { sessionId: 'sess_github_raw', toolCallId: 'call_2' });
  const small = await tool({ action: 'pr.merge', repo, number: 7, sha }, () => JSON.stringify({ sha, merged: true, message: 'Merged' }), { sessionId: 'sess_github_raw', toolCallId: 'call_3' });
  return { pr, projected, repoView, bodies, issueListSixty: listed, merged: small, sessionIds: ['sess_github_raw'] };
}));
await set.run('list actions return compact projected rows while raw keeps the full response', () => withDataDir('github-list-', async () => {
  const user = { login: 'alice', id: 1, type: 'User', avatar_url: 'a' };
  const body = `line one\n\n  line   two ${'x'.repeat(300)}`;
  const common = { user, body, updated_at: '2026-10-01T12:00:00Z', url: 'https://api.github.com/x', reactions: { total_count: 3 } };
  const calls = [];
  const call = async (action, items, extra = {}, collection) => {
    const out = await tool({ action, repo, ...extra }, () => JSON.stringify(collection ? { [collection]: items } : items), { sessionId: 'sess_github_list', toolCallId: `call_${action}` });
    calls.push({ action, collection, items, extra, text: out.text, rawFile: out.rawFile });
  };
  await call('issue.list', [{ ...common, number: 1, title: 'Bug', state: 'open', labels: [{ name: 'bug', id: 9 }], comments: 2 }]);
  await call('issue.list', [{ number: 2, title: 'T', state: 'closed', user, body: '', labels: [], comments: 0 }]);
  const head = { ref: 'feature', sha, repo: { full_name: 'fork/project' } };
  const base = { ref: 'main', sha, repo: { full_name: repo } };
  await call('pr.list', [
    { ...common, number: 3, title: 'A', state: 'closed', merged_at: '2026-10-02T00:00:00Z', head, base, draft: false, merge_commit_sha: sha },
    { ...common, number: 4, title: 'B', state: 'closed', merged_at: null, head, base },
    { ...common, number: 5, title: 'C', state: 'open', draft: true, head, base, labels: [{ name: 'x' }] },
  ]);
  await call('repo.list', [{ full_name: 'o/r', description: 'd', private: true, language: 'JS', pushed_at: '2026-09-01T00:00:00Z', id: 1 }]);
  await call('run.list', [{ id: 8, name: 'CI', display_title: 'Fix', status: 'completed', conclusion: 'failure', head_branch: 'main', event: 'push', actor: user, updated_at: '2026-10-03T00:00:00Z', head_commit: {} }], {}, 'workflow_runs');
  await call('release.list', [{ id: 5, tag_name: 'v1', name: 'One', draft: false, prerelease: true, author: user, published_at: '2026-10-04T00:00:00Z', body }]);
  await call('notification.list', [{ id: '9', unread: true, reason: 'mention', updated_at: '2026-10-05T00:00:00Z', subject: { type: 'PullRequest', title: 'P', url: 'https://api.github.com/repos/o/r/pulls/12' }, repository: { full_name: 'o/r', id: 1 } }]);
  await call('workflow.list', [{ id: 3, name: 'CI', path: '.github/workflows/ci.yml', state: 'active', badge_url: 'b' }], {}, 'workflows');
  const view = await tool({ action: 'issue.view', repo, number: 1 }, () => JSON.stringify({ ...common, number: 1, title: 'Bug' }));
  return { calls, issueView: view };
}));
await set.run('pr.view and issue.view keep the decision fields, cap the body and keep raw whole', () => withDataDir('github-view-', async () => {
  const user = { login: 'alice', id: 1, node_id: 'U', type: 'User', avatar_url: 'a' };
  const noise = { id: 99, node_id: 'N', url: 'https://api.github.com/x', comments_url: 'c', commits_url: 'c', diff_url: 'd', author_association: 'MEMBER', performed_via_github_app: null, reactions: { url: 'u', total_count: 0, '+1': 0, '-1': 0 }, sub_issues_summary: { total: 0, completed: 0, percent_completed: 0 }, issue_dependencies_summary: { blocked_by: 0, blocking: 0 }, _links: { self: 'x' } };
  const body = `${'b'.repeat(1499)}\r\n${'tail'.repeat(100)}`;
  const view = (args, payload) => tool({ repo, ...args }, () => JSON.stringify(payload), { sessionId: 'sess_github_view', toolCallId: `call_${args.action}` });
  const pr = { ...noise, number: 7, title: 'Fix', state: 'open', draft: false, merged: false, mergeable: null, mergeable_state: null, user, labels: [{ id: 1, node_id: 'L', url: 'u', name: 'bug', color: 'f00' }], head: { ref: 'feature', sha, label: 'fork:feature', repo: { full_name: 'fork/project', id: 5 }, user }, base: { ref: 'main', sha: 'b'.repeat(40), label: 'o:main', repo: { full_name: repo } }, commits: 3, additions: 10, deletions: 2, changed_files: 4, comments: 1, review_comments: 2, html_url: 'https://github.com/owner/project/pull/7', created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-02T00:00:00Z', closed_at: null, merged_at: null, body };
  const issue = { ...noise, number: 7, title: 'Bug', state: 'closed', state_reason: 'completed', user, labels: [{ name: 'bug' }, 'p1'], assignees: [user], milestone: { id: 4, number: 1, title: 'v1', url: 'u' }, comments: 5, html_url: 'https://github.com/owner/project/issues/7', created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-02T00:00:00Z', closed_at: '2026-10-03T00:00:00Z', body: 'short body' };
  const generic = await view({ action: 'run.view', id: 5 }, { ...noise, name: 'CI', status: 'completed' });
  const enterprise = await tool({ action: 'repo.view', repo, hostname: 'ghe.example.com' }, () => '{"full_name":"owner/project"}');
  return { prPayload: pr, prView: await view({ action: 'pr.view', number: 7 }, pr), issuePayload: issue, issueView: await view({ action: 'issue.view', number: 7 }, issue), generic, enterprise };
}));
await set.run('list results omit raw unless rows or excerpts were cut', () => withDataDir('github-list-raw-', async () => {
  const list = (items, extra = {}) => tool({ action: 'issue.list', repo, ...extra }, () => JSON.stringify(items), { sessionId: 'sess_github_list_raw', toolCallId: `call_${items.length}_${extra.limit || 0}` });
  const whole = await list([{ number: 1, title: 'T', state: 'open', body: 'short', url: 'u' }]);
  const excerptCut = await list([{ number: 1, title: 'T', state: 'open', body: 'x'.repeat(500) }]);
  const many = Array.from({ length: 60 }, (_, index) => ({ number: index + 1, title: 't'.repeat(200) }));
  const rowsCut = await list(many, { limit: 60 });
  return { whole, excerptCut, rowsCut };
}));
await set.run('results that cannot be clamped by strings still fit the output cap', async () => {
  const assets = Array.from({ length: 500 }, (_, index) => ({ id: index, name: `asset-${index}.zip`, size: index }));
  const view = await tool({ action: 'release.view', repo, id: 42 }, () => JSON.stringify({ id: 42, tag_name: 'v1', name: 'One', assets }));
  const wide = { number: 1, ...Object.fromEntries(Array.from({ length: 3000 }, (_, i) => [`k${i}`, i])) };
  const page = await tool({ action: 'issue.list', repo, limit: 2 }, () => JSON.stringify([wide, { number: 2 }]));
  return { capBytes: 10 * 1024, releaseView: view, wideList: page };
});
await set.run('review requires an explicit verdict and merges require an exact full commit identity', () => {
  const tryValidate = (input) => { try { validateGithubRequest(input); return { ok: true }; } catch (e) { return { threw: e }; } };
  const command = buildGithubCommand({ action: 'pr.review', repo, number: 1, sha, event: 'APPROVE' });
  return { reviewWithoutEvent: tryValidate({ action: 'pr.review', repo, number: 1, sha, body: 'x' }), mergeBranchName: tryValidate({ action: 'pr.merge', repo, number: 1, sha: 'main' }), approve: { command: cmdView(command), commitId: JSON.parse(command.input).commit_id } };
});
await set.run('two clones cannot claim the same new destination, even for different repositories', async () => {
  const directory = await tmpdirFor('github-clone-race-');
  let executions = 0;
  const destination = join(directory, 'clone');
  const results = await Promise.allSettled(['owner/one', 'owner/two'].map((source) => executeGithubRequest({ action: 'repo.clone', repo: source, destination }, CWD, { run: async () => { executions++; return 'cloned'; } })));
  return { destination, executions, outcomes: results.map((r) => (r.status === 'fulfilled' ? { fulfilled: r.value } : { rejected: r.reason })) };
});

await set.finish({
  entry: { runs: 'src/runtime/github/contract.mjs, commands.mjs, client.mjs (executeGithubRequest), tool.mjs (executeGithubTool), the builtin registry (executeBuiltinTool/isBuiltinTool) and tool-classify _isMutationTool, with the process runner `run` scripted (the injection point the tests use)', notRun: 'no `gh` process, no network; the cwd is the process cwd (the repo inference reads its response from the scripted run)' },
  replay: { entry: 'mixdog-scm gh/client.rs and mixdog-tools github: drive the same request/tool calls with the recorded scripted runner responses and compare the commands built (args, stdin, mutation), the results/errors and the tool text whole (and raw files)', normalised: { tempDirs: 'temp dirs (clone destinations, data dirs, raw file paths) are <tmp>/<data>; a replay must substitute its own and compare the rest', cwd: 'the process cwd is not recorded' } },
  replaceInText: [[tmpdir(), '<tmp>'], [tmpdir().replaceAll('\\', '/'), '<tmp>']],
  replaceRegex: [[/(<tmp>[\\\\/]+github(?:-[a-z]+)*)-[A-Za-z0-9]{6}/g, '$1-XXXXXX']],
});
for (const d of dirs) await rm(d, { recursive: true, force: true }).catch(() => {});
process.exit(0);
