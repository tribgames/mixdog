import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { GITHUB_ACTIONS, githubRequestMutates, validateGithubRequest } from './contract.mjs';
import { buildGithubCommand } from './commands.mjs';
import { executeGithubRequest } from './client.mjs';
import { executeGithubTool } from './tool.mjs';
import { _isMutationTool } from '../agent/orchestrator/session/loop/tool-classify.mjs';
import { executeBuiltinTool, isBuiltinTool } from '../agent/orchestrator/tools/builtin.mjs';

const cwd = process.cwd();
const sha = 'a'.repeat(40);
const repo = 'owner/project';
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
const responseFor = (command) => {
  if (command.list) return JSON.stringify(command.collection ? { [command.collection]: [] } : []);
  return command.json ? JSON.stringify({ id: 42, number: 7, merged: true }) : 'done';
};

test('every supported operation executes through a bounded, non-interactive request', async () => {
  const examples = {
    'repo.list': {},
    'repo.view': {},
    'repo.create': { visibility: 'private' },
    'repo.fork': {},
    'issue.list': {},
    'issue.view': { number: 7 },
    'issue.comments': { number: 7 },
    'issue.create': { title: '새 이슈', body: '설명' },
    'issue.edit': { number: 7, labels: ['bug'], assignees: ['owner'] },
    'issue.close': { number: 7 },
    'issue.reopen': { number: 7 },
    'issue.comment': { number: 7, body: '댓글' },
    'pr.list': {},
    'pr.view': { number: 7 },
    'pr.create': { title: 'PR', head: 'topic', base: 'main', draft: true },
    'pr.checkout': { number: 7 },
    'pr.merge': { number: 7, sha },
    'pr.review': { number: 7, sha, event: 'REQUEST_CHANGES', body: '수정 요청' },
    'pr.comment': { number: 7, body: '설명' },
    'pr.comments': { number: 7 },
    'workflow.list': {},
    'workflow.run': { workflow: 'test.yml', ref: 'main', inputs: { version: '1' } },
    'run.list': {},
    'run.view': { id: 42 },
    'run.logs': { id: 42, failed: true },
    'run.rerun': { id: 42, failed: true },
    'run.cancel': { id: 42 },
    'release.list': {},
    'release.view': { id: 42 },
    'release.create': { tag: 'v1.0', title: 'Version 1', draft: true },
    'release.edit': { id: 42, draft: false },
    'notification.list': {},
    'notification.read': { id: 42 },
  };
  const directory = await mkdtemp(join(tmpdir(), 'mixdog-github-'));
  examples['repo.clone'] = { destination: join(directory, 'new-repo') };
  try {
    assert.deepEqual(Object.keys(examples).sort(), Object.keys(GITHUB_ACTIONS).sort());
    for (const [action, fields] of Object.entries(examples)) {
      const calls = [];
      const result = await executeGithubRequest({ action, repo, ...fields }, cwd, {
        run: async (command) => {
          calls.push(command);
          return responseFor(command);
        },
      });
      assert.equal(result.action, action);
      assert.equal(calls.length, 1, action);
      if (calls[0].args[0] === 'api') {
        const method = calls[0].args[calls[0].args.indexOf('--method') + 1];
        assert.equal(method !== 'GET', githubRequestMutates({ action }), action);
      }
      assert.equal(_isMutationTool('github', { action }), githubRequestMutates({ action }), action);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('invalid requests cannot launch a process or smuggle API/CLI flags', async () => {
  let calls = 0;
  for (const input of [
    { action: 'api', endpoint: 'user' },
    { action: 'repo.view', repo: '--help/x' },
    { action: 'repo.view', repo: 'https://github.com/owner/repo' },
    { action: 'repo.view', repo: 'a/..' },
    { action: 'repo.view', hostname: 'https://github.com' },
    { action: 'issue.create', repo, title: 'x', command: 'whoami' },
    { action: 'issue.close', repo },
    { action: 'issue.view', repo, number: '7' },
    { action: 'issue.list', repo, limit: 101 },
    { action: 'issue.create', repo, title: 'x', labels: ['ok', null] },
    { action: 'workflow.run', repo, workflow: 'test.yml', ref: '--help' },
    { action: 'workflow.run', repo, workflow: 'test.yml', ref: 'main', inputs: { unsafe: 12 } },
    { action: 'pr.merge', repo, number: 7 },
    { action: 'pr.review', repo, number: 7, sha, event: 'REQUEST_CHANGES', body: '' },
    { action: 'repo.create', visibility: 'private' },
    { action: 'repo.clone', repo, destination: '.' },
  ]) {
    await assert.rejects(
      () =>
        executeGithubRequest(input, cwd, {
          run: async () => {
            calls++;
            return '{}';
          },
        }),
      undefined,
      JSON.stringify(input)
    );
  }
  assert.equal(calls, 0);
  assert.equal(githubRequestMutates({ action: 'unknown' }), true);
});

test('Korean titles and shell-looking bodies remain JSON data', () => {
  const body = '`whoami`; $(Remove-Item x)\n한글 & 제목';
  const command = buildGithubCommand({ action: 'issue.create', repo, title: '--help', body });
  assert.equal(command.args.includes(body), false);
  assert.equal(JSON.parse(command.input).body, body);
  assert.equal(JSON.parse(command.input).title, '--help');
});

test('workflow-filtered run lists execute once without a failed unfiltered request', async () => {
  for (const workflow of ['build.yml', 'deploy.yml', 'release-projectaa.yml', '42']) {
    const calls = [];
    const result = await executeGithubRequest({ action: 'run.list', repo, workflow, page: 2, limit: 3 }, cwd, {
      run: async (command) => {
        calls.push(command);
        return JSON.stringify({ workflow_runs: [{ id: 42 }] });
      },
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].args[1], `repos/${repo}/actions/workflows/${workflow}/runs?per_page=3&page=2`);
    assert.equal(calls[0].mutation, false);
    assert.equal(calls[0].args.at(-1), 'GET');
    assert.deepEqual(result.data, [{ id: 42 }]);
    assert.equal(result.page, 2);
  }
  assert.equal(
    buildGithubCommand({ action: 'run.list', repo }).args[1],
    `repos/${repo}/actions/runs?per_page=30&page=1`
  );
  assert.throws(() => validateGithubRequest({ action: 'run.list', repo, state: 'all' }), /Unsupported field/);
});

test('repo inference binds the write to the resolved Project repository', async () => {
  const commands = [];
  const result = await executeGithubRequest({ action: 'issue.create', title: 'Bound' }, cwd, {
    run: async (command) => {
      commands.push(command);
      return commands.length === 1 ? JSON.stringify({ nameWithOwner: repo }) : JSON.stringify({ number: 9 });
    },
  });
  assert.equal(result.repo, repo);
  assert.equal(result.data.number, 9);
  assert.equal(commands[1].args[1], `repos/${repo}/issues`);
});

test('issues paginate on the original page even when it only contains pull requests', async () => {
  const result = await executeGithubRequest({ action: 'issue.list', repo, page: 3, limit: 2 }, cwd, {
    run: async () =>
      JSON.stringify([
        { id: 1, pull_request: {} },
        { id: 2, pull_request: {} },
      ]),
  });
  assert.deepEqual(result.data, []);
  assert.equal(result.page, 3);
  assert.equal(result.hasMore, true);
});

test('writes serialize; a failed write is never replayed and does not poison the next call', async () => {
  const first = deferred();
  const started = deferred();
  const order = [];
  const run = async (command) => {
    const title = JSON.parse(command.input).title;
    order.push(title);
    if (title === 'first') {
      started.resolve();
      await first.promise;
      throw new Error('connection lost');
    }
    return '{"number":8}';
  };
  const a = executeGithubRequest({ action: 'issue.create', repo, title: 'first' }, cwd, { run });
  const failure = assert.rejects(a, /connection lost/);
  await started.promise;
  const b = executeGithubRequest({ action: 'issue.create', repo, title: 'second' }, cwd, { run });
  assert.deepEqual(order, ['first']);
  first.resolve();
  await failure;
  assert.equal((await b).data.number, 8);
  assert.deepEqual(order, ['first', 'second']);
});

test('cancelled and existing-destination requests leave files and remote state untouched', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mixdog-github-protected-'));
  let calls = 0;
  const run = async () => {
    calls++;
    return '';
  };
  try {
    await assert.rejects(
      executeGithubRequest({ action: 'repo.clone', repo, destination: directory }, cwd, { run }),
      /already exists/
    );
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      executeGithubRequest({ action: 'issue.list', repo }, cwd, { run, abortSignal: controller.signal }),
      /cancelled/
    );
    assert.equal(calls, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('merge refusal and unreadable write responses are errors, not successful actions', async () => {
  await assert.rejects(
    executeGithubRequest({ action: 'pr.merge', repo, number: 7, sha }, cwd, {
      run: async () => '{"merged":false,"message":"Head changed"}',
    }),
    /Head changed/
  );
  await assert.rejects(
    executeGithubRequest({ action: 'issue.create', repo, title: 'X' }, cwd, {
      run: async () => 'not-json',
    }),
    /do not replay/
  );
});

test('the agent tool is registered and returns the ordinary builtin text/error contract', async () => {
  assert.equal(isBuiltinTool('github'), true);
  const value = await executeBuiltinTool('github', { action: 'repo.view', repo }, cwd, {
    run: async () => '{"full_name":"owner/project"}',
  });
  assert.equal(JSON.parse(value).data.full_name, repo);
  assert.match(await executeGithubTool({ action: 'not-supported' }, cwd), /^Error:/);
  const bounded = await executeGithubTool({ action: 'run.logs', repo, id: 42 }, cwd, {
    run: async () => '한'.repeat(100000),
  });
  const logs = JSON.parse(bounded);
  assert.ok(Buffer.byteLength(bounded, 'utf8') <= 10 * 1024);
  assert.ok(logs.data.endsWith('한'));
  assert.match(logs.omitted, /failed:true/);
});

test('model-facing results drop API-only fields, keep decision fields, and preserve the raw response', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'mixdog-github-raw-'));
  const previous = process.env.MIXDOG_DATA_DIR;
  process.env.MIXDOG_DATA_DIR = dataDir;
  try {
    const user = (login, type = 'User') => ({ login, id: 1, node_id: 'U', type, avatar_url: 'a', followers_url: 'f' });
    const nested = { full_name: 'fork/project', id: 2, owner: user('fork'), forks_url: 'x', clone_url: 'c' };
    const pr = {
      id: 123,
      number: 7,
      title: 'Fix',
      state: 'open',
      body: 'details',
      node_id: 'PR',
      url: 'https://api.github.com/x',
      html_url: 'https://github.com/x',
      diff_url: 'd',
      comments_url: 'c',
      author_association: 'MEMBER',
      performed_via_github_app: null,
      reactions: { url: 'u', total_count: 0, '+1': 0 },
      milestone: { id: 3, number: 2, title: 'M', url: 'u' },
      user: user('alice'),
      assignees: [user('bob')],
      requested_reviewers: [user('ci', 'Bot')],
      labels: [{ name: 'bug', node_id: 'L' }],
      head: { sha, ref: 'feature', repo: nested, user: user('fork') },
      base: { ref: 'main', repo: { ...nested, full_name: repo } },
      commit: { author: { name: 'Alice', email: 'a@example.com' } },
      _links: { self: 'x' },
    };
    const value = JSON.parse(
      await executeGithubTool({ action: 'run.view', repo, id: 7 }, cwd, {
        sessionId: 'sess_github_raw',
        toolCallId: 'call_1',
        run: async () => JSON.stringify(pr),
      })
    );
    assert.equal(value.hostname, undefined);
    assert.deepEqual(value.data, {
      number: 7,
      title: 'Fix',
      state: 'open',
      body: 'details',
      html_url: 'https://github.com/x',
      milestone: { number: 2, title: 'M' },
      user: 'alice',
      assignees: ['bob'],
      requested_reviewers: ['ci (Bot)'],
      labels: [{ name: 'bug' }],
      head: { sha, ref: 'feature', repo: 'fork/project', user: 'fork' },
      base: { ref: 'main', repo },
      commit: { author: { name: 'Alice', email: 'a@example.com' } },
    });
    assert.deepEqual(JSON.parse(await readFile(value.raw, 'utf8')), pr);

    const repoView = JSON.parse(
      await executeGithubTool({ action: 'repo.view', repo }, cwd, {
        run: async () => JSON.stringify({ ...nested, full_name: repo }),
      })
    );
    assert.deepEqual(repoView.data, { full_name: repo, id: 2, owner: 'fork' });
    assert.match(repoView.raw, /unavailable/);

    const bodies = await executeGithubTool({ action: 'pr.list', repo, limit: 2 }, cwd, {
      sessionId: 'sess_github_raw',
      toolCallId: 'call_bodies',
      run: async () => JSON.stringify([1, 2].map((number) => ({ number, body: 'y'.repeat(20000) }))),
    });
    const overview = JSON.parse(bodies);
    assert.deepEqual(
      overview.data.map((item) => item.number),
      [1, 2]
    );
    assert.equal(overview.data[0].excerpt.length, 140);
    assert.equal(overview.data[0].body, undefined);
    assert.equal(overview.omitted, undefined);
    assert.equal(JSON.parse(await readFile(overview.raw, 'utf8'))[0].body.length, 20000);

    const page = Array.from({ length: 60 }, (_, index) => ({ number: index + 1, title: 't'.repeat(200) }));
    const listed = await executeGithubTool({ action: 'issue.list', repo, limit: 60 }, cwd, {
      sessionId: 'sess_github_raw',
      toolCallId: 'call_2',
      run: async () => JSON.stringify(page),
    });
    const list = JSON.parse(listed);
    assert.ok(Buffer.byteLength(listed, 'utf8') <= 10 * 1024);
    assert.deepEqual(
      list.data.map((item) => item.number),
      Array.from({ length: list.data.length }, (_, index) => index + 1)
    );
    assert.equal(list.hasMore, true);
    assert.match(list.omitted, new RegExp(`records ${list.data.length + 1}-60`));
    assert.equal(JSON.parse(await readFile(list.raw, 'utf8')).length, 60);

    const small = await executeGithubTool({ action: 'pr.merge', repo, number: 7, sha }, cwd, {
      sessionId: 'sess_github_raw',
      toolCallId: 'call_3',
      run: async () => JSON.stringify({ sha, merged: true, message: 'Merged' }),
    });
    assert.equal(JSON.parse(small).raw, undefined);
  } finally {
    if (previous === undefined) delete process.env.MIXDOG_DATA_DIR;
    else process.env.MIXDOG_DATA_DIR = previous;
    // The session store may still be writing session-pending into the data dir.
    await rm(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test('list actions return compact projected rows while raw keeps the full response', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'mixdog-github-list-'));
  const previous = process.env.MIXDOG_DATA_DIR;
  process.env.MIXDOG_DATA_DIR = dataDir;
  try {
    const user = { login: 'alice', id: 1, type: 'User', avatar_url: 'a' };
    const body = `line one\n\n  line   two ${'x'.repeat(300)}`;
    const common = {
      user,
      body,
      updated_at: '2026-10-01T12:00:00Z',
      url: 'https://api.github.com/x',
      reactions: { total_count: 3 },
    };
    // raw is only attached when a row or excerpt was cut.
    const call = async (action, items, extra = {}, collection, expectRaw = false) => {
      const text = await executeGithubTool({ action, repo, ...extra }, cwd, {
        sessionId: 'sess_github_list',
        toolCallId: `call_${action}`,
        run: async () => JSON.stringify(collection ? { [collection]: items } : items),
      });
      const parsed = JSON.parse(text);
      if (expectRaw) assert.deepEqual(JSON.parse(await readFile(parsed.raw, 'utf8')), items);
      else assert.equal(parsed.raw, undefined, action);
      return parsed.data;
    };

    const [issue] = await call(
      'issue.list',
      [{ ...common, number: 1, title: 'Bug', state: 'open', labels: [{ name: 'bug', id: 9 }], comments: 2 }],
      {},
      undefined,
      true
    );
    assert.deepEqual(issue, {
      number: 1,
      title: 'Bug',
      state: 'open',
      author: 'alice',
      updated: '2026-10-01',
      labels: ['bug'],
      comments: 2,
      excerpt: issue.excerpt,
    });
    assert.equal(issue.excerpt.length, 140);
    assert.ok(issue.excerpt.startsWith('line one line two x'));
    assert.ok(issue.excerpt.endsWith('…'));
    const [bare] = await call('issue.list', [
      { number: 2, title: 'T', state: 'closed', user, body: '', labels: [], comments: 0 },
    ]);
    assert.deepEqual(bare, { number: 2, title: 'T', state: 'closed', author: 'alice' });

    const head = { ref: 'feature', sha, repo: { full_name: 'fork/project' } };
    const base = { ref: 'main', sha, repo: { full_name: repo } };
    const prs = await call(
      'pr.list',
      [
        {
          ...common,
          number: 3,
          title: 'A',
          state: 'closed',
          merged_at: '2026-10-02T00:00:00Z',
          head,
          base,
          draft: false,
          merge_commit_sha: sha,
        },
        { ...common, number: 4, title: 'B', state: 'closed', merged_at: null, head, base },
        { ...common, number: 5, title: 'C', state: 'open', draft: true, head, base, labels: [{ name: 'x' }] },
      ],
      {},
      undefined,
      true
    );
    assert.deepEqual(
      prs.map((item) => [item.state, item.draft, item.head, item.base]),
      [
        ['merged', undefined, 'feature', 'main'],
        ['closed', undefined, 'feature', 'main'],
        ['open', true, 'feature', 'main'],
      ]
    );
    assert.deepEqual(prs[2].labels, ['x']);
    assert.equal(prs[0].merge_commit_sha, undefined);

    assert.deepEqual(
      await call('repo.list', [
        { full_name: 'o/r', description: 'd', private: true, language: 'JS', pushed_at: '2026-09-01T00:00:00Z', id: 1 },
      ]),
      [{ name: 'o/r', description: 'd', visibility: 'private', language: 'JS', updated: '2026-09-01' }]
    );
    assert.deepEqual(
      await call(
        'run.list',
        [
          {
            id: 8,
            name: 'CI',
            display_title: 'Fix',
            status: 'completed',
            conclusion: 'failure',
            head_branch: 'main',
            event: 'push',
            actor: user,
            updated_at: '2026-10-03T00:00:00Z',
            head_commit: {},
          },
        ],
        {},
        'workflow_runs'
      ),
      [
        {
          id: 8,
          name: 'Fix',
          workflow: 'CI',
          status: 'completed',
          conclusion: 'failure',
          branch: 'main',
          event: 'push',
          actor: 'alice',
          updated: '2026-10-03',
        },
      ]
    );
    assert.deepEqual(
      await call('release.list', [
        {
          id: 5,
          tag_name: 'v1',
          name: 'One',
          draft: false,
          prerelease: true,
          author: user,
          published_at: '2026-10-04T00:00:00Z',
          body,
        },
      ]),
      [{ id: 5, tag: 'v1', name: 'One', prerelease: true, author: 'alice', published: '2026-10-04' }]
    );
    assert.deepEqual(
      await call('notification.list', [
        {
          id: '9',
          unread: true,
          reason: 'mention',
          updated_at: '2026-10-05T00:00:00Z',
          subject: { type: 'PullRequest', title: 'P', url: 'https://api.github.com/repos/o/r/pulls/12' },
          repository: { full_name: 'o/r', id: 1 },
        },
      ]),
      [
        {
          id: '9',
          unread: true,
          reason: 'mention',
          type: 'PullRequest',
          title: 'P',
          number: 12,
          repo: 'o/r',
          updated: '2026-10-05',
        },
      ]
    );
    assert.deepEqual(
      await call(
        'workflow.list',
        [{ id: 3, name: 'CI', path: '.github/workflows/ci.yml', state: 'active', badge_url: 'b' }],
        {},
        'workflows'
      ),
      [{ id: 3, name: 'CI', path: '.github/workflows/ci.yml', state: 'active' }]
    );

    const view = JSON.parse(
      await executeGithubTool({ action: 'issue.view', repo, number: 1 }, cwd, {
        run: async () => JSON.stringify({ ...common, number: 1, title: 'Bug' }),
      })
    );
    assert.equal(view.data.body, body);
    assert.equal(view.data.author, undefined);
  } finally {
    if (previous === undefined) delete process.env.MIXDOG_DATA_DIR;
    else process.env.MIXDOG_DATA_DIR = previous;
    await rm(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test('pr.view and issue.view keep the decision fields, cap the body and keep raw whole', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'mixdog-github-view-'));
  const previous = process.env.MIXDOG_DATA_DIR;
  process.env.MIXDOG_DATA_DIR = dataDir;
  try {
    const user = { login: 'alice', id: 1, node_id: 'U', type: 'User', avatar_url: 'a' };
    const noise = {
      id: 99,
      node_id: 'N',
      url: 'https://api.github.com/x',
      comments_url: 'c',
      commits_url: 'c',
      diff_url: 'd',
      author_association: 'MEMBER',
      performed_via_github_app: null,
      reactions: { url: 'u', total_count: 0, '+1': 0, '-1': 0 },
      sub_issues_summary: { total: 0, completed: 0, percent_completed: 0 },
      issue_dependencies_summary: { blocked_by: 0, blocking: 0 },
      _links: { self: 'x' },
    };
    const body = `${'b'.repeat(1499)}\r\n${'tail'.repeat(100)}`;
    const view = async (args, payload) =>
      JSON.parse(
        await executeGithubTool({ repo, ...args }, cwd, {
          sessionId: 'sess_github_view',
          toolCallId: `call_${args.action}`,
          run: async () => JSON.stringify(payload),
        })
      );

    const pr = {
      ...noise,
      number: 7,
      title: 'Fix',
      state: 'open',
      draft: false,
      merged: false,
      mergeable: null,
      mergeable_state: null,
      user,
      labels: [{ id: 1, node_id: 'L', url: 'u', name: 'bug', color: 'f00' }],
      head: { ref: 'feature', sha, label: 'fork:feature', repo: { full_name: 'fork/project', id: 5 }, user },
      base: { ref: 'main', sha: 'b'.repeat(40), label: 'o:main', repo: { full_name: repo } },
      commits: 3,
      additions: 10,
      deletions: 2,
      changed_files: 4,
      comments: 1,
      review_comments: 2,
      html_url: 'https://github.com/owner/project/pull/7',
      created_at: '2026-10-01T00:00:00Z',
      updated_at: '2026-10-02T00:00:00Z',
      closed_at: null,
      merged_at: null,
      body,
    };
    const prResult = await view({ action: 'pr.view', number: 7 }, pr);
    assert.equal(prResult.hostname, undefined);
    const { body: prBody, ...prData } = prResult.data;
    assert.deepEqual(prData, {
      number: 7,
      title: 'Fix',
      state: 'open',
      draft: false,
      merged: false,
      mergeable: null,
      mergeable_state: null,
      user: 'alice',
      labels: ['bug'],
      head: { ref: 'feature', sha, repo: 'fork/project' },
      base: { ref: 'main', sha: 'b'.repeat(40) },
      commits: 3,
      additions: 10,
      deletions: 2,
      changed_files: 4,
      comments: 1,
      review_comments: 2,
      html_url: 'https://github.com/owner/project/pull/7',
      created_at: '2026-10-01T00:00:00Z',
      updated_at: '2026-10-02T00:00:00Z',
    });
    assert.ok('mergeable' in prData && 'mergeable_state' in prData);
    assert.match(prBody, /^b{1499}\n… 400 more chars in raw$/);
    assert.deepEqual(JSON.parse(await readFile(prResult.raw, 'utf8')), pr);

    const issue = {
      ...noise,
      number: 7,
      title: 'Bug',
      state: 'closed',
      state_reason: 'completed',
      user,
      labels: [{ name: 'bug' }, 'p1'],
      assignees: [user],
      milestone: { id: 4, number: 1, title: 'v1', url: 'u' },
      comments: 5,
      html_url: 'https://github.com/owner/project/issues/7',
      created_at: '2026-10-01T00:00:00Z',
      updated_at: '2026-10-02T00:00:00Z',
      closed_at: '2026-10-03T00:00:00Z',
      body: 'short body',
    };
    const issueResult = await view({ action: 'issue.view', number: 7 }, issue);
    assert.deepEqual(issueResult.data, {
      number: 7,
      title: 'Bug',
      state: 'closed',
      state_reason: 'completed',
      user: 'alice',
      labels: ['bug', 'p1'],
      assignees: ['alice'],
      milestone: 'v1',
      comments: 5,
      html_url: 'https://github.com/owner/project/issues/7',
      created_at: '2026-10-01T00:00:00Z',
      updated_at: '2026-10-02T00:00:00Z',
      closed_at: '2026-10-03T00:00:00Z',
      body: 'short body',
    });
    assert.deepEqual(JSON.parse(await readFile(issueResult.raw, 'utf8')), issue);

    // Generic reduction drops the same noise from non-projected views.
    const generic = await view({ action: 'run.view', id: 5 }, { ...noise, name: 'CI', status: 'completed' });
    assert.deepEqual(generic.data, { id: 99, name: 'CI', status: 'completed' });

    // Enterprise hosts stay named; github.com is implied.
    const enterprise = JSON.parse(
      await executeGithubTool({ action: 'repo.view', repo, hostname: 'ghe.example.com' }, cwd, {
        run: async () => '{"full_name":"owner/project"}',
      })
    );
    assert.equal(enterprise.hostname, 'ghe.example.com');
  } finally {
    if (previous === undefined) delete process.env.MIXDOG_DATA_DIR;
    else process.env.MIXDOG_DATA_DIR = previous;
    await rm(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test('list results omit raw unless rows or excerpts were cut', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'mixdog-github-list-raw-'));
  const previous = process.env.MIXDOG_DATA_DIR;
  process.env.MIXDOG_DATA_DIR = dataDir;
  try {
    const list = async (items, extra = {}) =>
      JSON.parse(
        await executeGithubTool({ action: 'issue.list', repo, ...extra }, cwd, {
          sessionId: 'sess_github_list_raw',
          toolCallId: `call_${items.length}_${extra.limit || 0}`,
          run: async () => JSON.stringify(items),
        })
      );
    const whole = await list([{ number: 1, title: 'T', state: 'open', body: 'short', url: 'u' }]);
    assert.equal(whole.raw, undefined);
    assert.equal(whole.hostname, undefined);
    assert.equal(whole.data[0].excerpt, 'short');

    const excerptCut = await list([{ number: 1, title: 'T', state: 'open', body: 'x'.repeat(500) }]);
    assert.ok(excerptCut.raw);
    assert.equal(JSON.parse(await readFile(excerptCut.raw, 'utf8'))[0].body.length, 500);

    const many = Array.from({ length: 60 }, (_, index) => ({ number: index + 1, title: 't'.repeat(200) }));
    const rowsCut = await list(many, { limit: 60 });
    assert.ok(rowsCut.data.length < 60);
    assert.equal(JSON.parse(await readFile(rowsCut.raw, 'utf8')).length, 60);
  } finally {
    if (previous === undefined) delete process.env.MIXDOG_DATA_DIR;
    else process.env.MIXDOG_DATA_DIR = previous;
    await rm(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test('results that cannot be clamped by strings still fit the output cap', async () => {
  const cap = 10 * 1024;
  const assets = Array.from({ length: 500 }, (_, index) => ({ id: index, name: `asset-${index}.zip`, size: index }));
  const view = await executeGithubTool({ action: 'release.view', repo, id: 42 }, cwd, {
    run: async () => JSON.stringify({ id: 42, tag_name: 'v1', name: 'One', assets }),
  });
  assert.ok(Buffer.byteLength(view, 'utf8') <= cap);
  const parsed = JSON.parse(view);
  assert.equal(parsed.data.tag_name, 'v1');
  assert.match(parsed.omitted, /raw/);
  assert.ok(parsed.shown);

  const wide = { number: 1, ...Object.fromEntries(Array.from({ length: 3000 }, (_, i) => [`k${i}`, i])) };
  const page = await executeGithubTool({ action: 'issue.list', repo, limit: 2 }, cwd, {
    run: async () => JSON.stringify([wide, { number: 2 }]),
  });
  assert.ok(Buffer.byteLength(page, 'utf8') <= cap);
});

test('review requires an explicit verdict and merges require an exact full commit identity', () => {
  assert.throws(() => validateGithubRequest({ action: 'pr.review', repo, number: 1, sha, body: 'x' }), /event/);
  assert.throws(() => validateGithubRequest({ action: 'pr.merge', repo, number: 1, sha: 'main' }), /hash/);
  const command = buildGithubCommand({ action: 'pr.review', repo, number: 1, sha, event: 'APPROVE' });
  assert.equal(JSON.parse(command.input).commit_id, sha);
});

test('two clones cannot claim the same new destination, even for different repositories', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mixdog-github-clone-race-'));
  let executions = 0;
  const destination = join(directory, 'clone');
  try {
    const results = await Promise.allSettled(
      ['owner/one', 'owner/two'].map((source) =>
        executeGithubRequest({ action: 'repo.clone', repo: source, destination }, cwd, {
          run: async () => {
            executions++;
            return 'cloned';
          },
        })
      )
    );
    assert.equal(executions, 1);
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
    assert.equal(results.filter((result) => result.status === 'rejected').length, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
