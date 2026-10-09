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
      number: 7,
      title: 'Fix',
      state: 'open',
      body: 'details',
      node_id: 'PR',
      url: 'https://api.github.com/x',
      html_url: 'https://github.com/x',
      diff_url: 'd',
      comments_url: 'c',
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
      await executeGithubTool({ action: 'pr.view', repo, number: 7 }, cwd, {
        sessionId: 'sess_github_raw',
        toolCallId: 'call_1',
        run: async () => JSON.stringify(pr),
      })
    );
    assert.deepEqual(value.data, {
      number: 7,
      title: 'Fix',
      state: 'open',
      body: 'details',
      url: 'https://api.github.com/x',
      html_url: 'https://github.com/x',
      diff_url: 'd',
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
    assert.deepEqual(repoView.data, { full_name: repo, id: 2, owner: 'fork', clone_url: 'c' });
    assert.match(repoView.raw, /unavailable/);

    const bodies = await executeGithubTool({ action: 'pr.list', repo, limit: 2 }, cwd, {
      run: async () => JSON.stringify([1, 2].map((number) => ({ number, body: 'y'.repeat(20000) }))),
    });
    const overview = JSON.parse(bodies);
    assert.deepEqual(
      overview.data.map((item) => item.number),
      [1, 2]
    );
    assert.match(overview.data[0].body, /more chars in raw\]$/);
    assert.equal(overview.omitted, undefined);

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
