// The git tool's managed-worktree surface: raw `git worktree …` commands map
// onto managed operations of the caller's Lead host (never a git write),
// action:"worktree" validates and forwards its fields, typed refusals carry
// what the caller must ask the user, and a caller no host claims is refused.
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { join, resolve } from 'node:path';
import { executeGitTool } from './git-command-tool.mjs';
import { registerWorktreeToolHost } from '../../../../shared/worktrees/tool-host.mjs';
import { worktreeError } from '../../../../shared/worktrees/contract.mjs';
import { canonicalPath } from '../../../../shared/worktrees/paths.mjs';
import { cleanupTempDirs, git, makeRepo, tempDir } from '../../../../shared/worktrees/test-support.mjs';

after(() => cleanupTempDirs());

const LEAD = 'sess_lead_tool';

/** A fake Lead host: records each request, answers with `answer(request)`. */
function withHost(t, answer) {
  const calls = [];
  const dispose = registerWorktreeToolHost({
    sessionId: () => LEAD,
    run: async (request, context) => {
      calls.push({ request, context });
      return answer(request);
    },
  });
  t.after(dispose);
  return calls;
}

const asLead = { sessionId: LEAD, toolCallId: 'call-1' };
const json = (text) => JSON.parse(text);

test('git worktree add maps to a managed worktree or snapshot; the path is never used', async (t) => {
  const repo = makeRepo();
  const head = git(repo, 'rev-parse', 'HEAD');
  git(repo, 'branch', 'existing');
  const commonDir = canonicalPath(join(repo, '.git'));
  const calls = withHost(t, (request) =>
    request.op === 'snapshot'
      ? { id: 'snapshot-1', path: '/managed/snapshot-1', baseCommit: request.commit }
      : { path: `/managed/${request.branch}`, branch: request.branch, worktreeId: 'w', created: request.create }
  );

  const created = json(await executeGitTool({ command: 'git worktree add -b feature ../next' }, repo, asLead));
  assert.equal(created.ok, true);
  assert.equal(created.path, '/managed/feature');
  assert.equal(created.requestedPath, resolve(repo, '../next'));
  assert.match(created.note, /did not move/);
  assert.deepEqual(calls[0].request, {
    op: 'add',
    branch: 'feature',
    create: true,
    startPoint: head,
    confirmLarge: false,
    txId: 'call-1:git worktree add -b feature ../next',
    repoCommonDir: commonDir,
  });
  assert.deepEqual(calls[0].context, { callerSessionId: LEAD });

  // An existing branch (named, or git's path-basename convenience) is checked out as it is.
  await executeGitTool({ command: 'git worktree add ../x existing', confirm_large: true }, repo, asLead);
  assert.deepEqual([calls[1].request.branch, calls[1].request.create, calls[1].request.confirmLarge], [
    'existing',
    false,
    true,
  ]);
  await executeGitTool({ command: 'git worktree add ../existing' }, repo, asLead);
  assert.deepEqual([calls[2].request.branch, calls[2].request.create], ['existing', false]);
  await executeGitTool({ command: 'git worktree add ../fresh-name' }, repo, asLead);
  assert.deepEqual([calls[3].request.branch, calls[3].request.create], ['fresh-name', true]);

  // Detached, or a commit that names no branch: a read-only snapshot.
  for (const command of ['git worktree add --detach ../snap', `git worktree add ../snap ${head.slice(0, 10)}`]) {
    const snapshot = json(await executeGitTool({ command }, repo, asLead));
    assert.equal(snapshot.snapshot, true);
    assert.equal(snapshot.commit, head);
    assert.equal(snapshot.path, '/managed/snapshot-1');
    assert.match(snapshot.note, /removed when this turn ends/);
    assert.equal(calls.at(-1).request.op, 'snapshot');
    assert.equal(calls.at(-1).request.commit, head);
  }

  // Refused before anything runs.
  const refused = [
    ['git worktree add -B existing ../y', /never reset a branch/],
    ['git worktree add -b existing ../y', /already exists/],
    ['git worktree add --orphan ../y', /not supported/],
    ['git worktree add ../y no-such-ref', /not a commit/],
  ];
  const before = calls.length;
  for (const [command, pattern] of refused) {
    assert.match(await executeGitTool({ command }, repo, asLead), pattern, command);
  }
  assert.equal(calls.length, before);
  assert.equal(git(repo, 'worktree', 'list', '--porcelain').match(/^worktree /gm).length, 1, 'git never ran');
});

test('remove, prune and the fixed-location subcommands map or refuse; a worker gets no worktree authority', async (t) => {
  const repo = makeRepo();
  const calls = withHost(t, (request) =>
    request.op === 'prune'
      ? { removed: ['old'], kept: [] }
      : request.op === 'list'
        ? []
        : { removed: { removed: true }, workspace: { cwd: repo, branch: 'main', revision: 3, worktreeId: null } }
  );
  const removed = json(await executeGitTool({ command: 'git worktree remove --force ../wt' }, repo, asLead));
  assert.deepEqual(calls[0].request, { op: 'remove-path', path: resolve(repo, '../wt'), force: true });
  assert.deepEqual(removed.workspace, { cwd: repo, branch: 'main', mergeTarget: null, revision: 3, worktreeId: null });
  assert.deepEqual(json(await executeGitTool({ command: 'git worktree prune' }, repo, asLead)).removed, ['old']);
  for (const sub of ['move ../a ../b', 'lock ../a', 'unlock ../a', 'repair']) {
    assert.match(await executeGitTool({ command: `git worktree ${sub}` }, repo, asLead), /fixed, locked locations/);
  }
  const worker = { sessionId: 'sess_worker', toolCallId: 'call-2' };
  for (const command of ['git worktree add -b w ../w', 'git worktree remove ../w', 'git worktree prune']) {
    assert.match(await executeGitTool({ command }, repo, worker), /belongs to the Lead session/, command);
  }
  assert.match(
    await executeGitTool({ action: 'worktree', worktree_action: 'enter' }, repo, worker),
    /belongs to the Lead session/
  );
});

test('git worktree prune validates every argument before any mutation and scopes to the repository', async (t) => {
  const repo = makeRepo();
  const commonDir = canonicalPath(join(repo, '.git'));
  const calls = withHost(t, (request) =>
    request.op === 'list'
      ? [
          { id: 'mine', repoCommonDir: commonDir, path: '/managed/mine', state: 'ready', removable: true },
          { id: 'theirs', repoCommonDir: join(tempDir(), '.git'), path: '/managed/theirs', state: 'ready', removable: true },
        ]
      : { removed: ['mine'], kept: [] }
  );
  // Help answers without running anything.
  for (const command of ['git worktree prune -h', 'git worktree add -h', 'git worktree remove -h', 'git worktree list -h']) {
    assert.ok(json(await executeGitTool({ command }, repo, asLead)).help, command);
  }
  // --help (a manual viewer) is refused by the git tool's policy before it gets here.
  assert.match(await executeGitTool({ command: 'git worktree prune --help' }, repo, asLead), /^error: /);
  // Unsupported options and arguments are rejected, not ignored.
  for (const command of [
    'git worktree prune --expire=now',
    'git worktree prune --expire now',
    'git worktree prune extra',
    'git worktree prune -n --bogus',
    'git worktree list --bogus',
  ]) {
    assert.match(await executeGitTool({ command }, repo, asLead), /^error: git worktree (prune|list): /, command);
  }
  assert.equal(calls.length, 0, 'no host call for help or a rejected command');
  // The preview names only this repository; the real prune carries the same scope.
  const preview = json(await executeGitTool({ command: 'git worktree prune -n -v' }, repo, asLead));
  assert.deepEqual(preview.wouldRemove.map((row) => row.id), ['mine']);
  assert.ok(calls.every((call) => call.request.op === 'list'));
  await executeGitTool({ command: 'git worktree prune' }, repo, asLead);
  assert.deepEqual(calls.at(-1).request, { op: 'prune', repoCommonDir: commonDir });
  await executeGitTool({ action: 'worktree', worktree_action: 'prune' }, repo, asLead);
  assert.deepEqual(calls.at(-1).request, { op: 'prune', repoCommonDir: commonDir, txId: 'call-1:prune' });
});

test('git worktree list shows managed owners and flags unmanaged worktrees; --porcelain stays raw git', async (t) => {
  const repo = makeRepo();
  const external = join(tempDir(), 'external');
  git(repo, 'worktree', 'add', '-q', '-b', 'side', external);
  const commonDir = canonicalPath(join(repo, '.git'));
  withHost(t, () => [
    {
      id: 'fix',
      repoCommonDir: commonDir,
      path: '/managed/fix',
      branch: 'mixdog/fix',
      ownerSessionId: LEAD,
      mergeTarget: 'main',
      state: 'ready',
      ownerLive: true,
      removable: false,
    },
    {
      id: 'snapshot-1',
      kind: 'snapshot',
      repoCommonDir: commonDir,
      path: '/managed/snapshot-1',
      branch: null,
      baseCommit: 'c'.repeat(40),
      holderSessionId: LEAD,
      state: 'ready',
      ownerLive: true,
      removable: false,
    },
    { id: 'elsewhere', repoCommonDir: '/other/.git', path: '/managed/elsewhere', branch: 'x', state: 'ready' },
  ]);
  const listed = json(await executeGitTool({ command: 'git worktree list' }, repo, asLead));
  assert.deepEqual(
    listed.worktrees.map((row) => [row.path, row.main ?? row.unmanaged ?? row.snapshot ?? row.ownerSessionId]),
    [
      [canonicalPath(repo), true],
      ['/managed/fix', LEAD],
      ['/managed/snapshot-1', true],
      [canonicalPath(external), true],
    ]
  );
  assert.equal(listed.worktrees[3].unmanaged, true);
  assert.equal(listed.worktrees[2].holderSessionId, LEAD);
  const porcelain = await executeGitTool({ command: 'git worktree list --porcelain' }, repo, asLead);
  assert.match(porcelain, /^worktree .+\nHEAD [0-9a-f]{40}\nbranch refs\/heads\/main/m);
  assert.match(porcelain, /branch refs\/heads\/side/);
});

test('action:worktree forwards its fields; dirty-choice and large-repo refusals round-trip through the user', async (t) => {
  const repo = makeRepo();
  let refuse = (request) => {
    if (!request.carry) {
      throw worktreeError('WORKTREE_DIRTY_CHOICE', undefined, { count: 2, paths: ['a.txt', 'b.txt'] });
    }
    if (!request.confirmLarge) {
      throw worktreeError('WORKTREE_LARGE_REPO_CONFIRM', undefined, {
        estimateBytes: 5 * 1024 * 1024,
        thresholdBytes: 1024,
      });
    }
    return {
      revision: 2,
      pending: false,
      changes: { mode: 'carried', count: 2 },
      workspace: { cwd: '/managed/fix', branch: 'mixdog/fix', mergeTarget: 'main', revision: 2, worktreeId: 'fix' },
    };
  };
  const calls = withHost(t, (request) => refuse(request));
  const enter = (extra = {}) =>
    executeGitTool({ action: 'worktree', worktree_action: 'enter', name: 'fix', ...extra }, repo, asLead);

  const dirty = json(await enter());
  assert.equal(dirty.ok, false);
  assert.equal(dirty.code, 'WORKTREE_DIRTY_CHOICE');
  assert.deepEqual(dirty.details, { count: 2, paths: ['a.txt', 'b.txt'] });
  assert.match(dirty.next, /carry:"leave" or carry:"carry"/);

  const large = json(await enter({ carry: 'carry' }));
  assert.equal(large.code, 'WORKTREE_LARGE_REPO_CONFIRM');
  assert.match(large.next, /about 5\.0 MB/);
  assert.match(large.next, /confirm_large:true/);

  const entered = json(await enter({ carry: 'carry', confirm_large: true }));
  assert.equal(entered.ok, true);
  assert.deepEqual(entered.changes, { mode: 'carried', count: 2 });
  assert.deepEqual(entered.workspace, {
    cwd: '/managed/fix',
    branch: 'mixdog/fix',
    mergeTarget: 'main',
    revision: 2,
    worktreeId: 'fix',
  });
  assert.equal(Object.hasOwn(entered, 'pending'), false);
  assert.deepEqual(calls.at(-1).request, {
    op: 'enter',
    name: 'fix',
    branch: null,
    create: false,
    carry: 'carry',
    confirmLarge: true,
    txId: 'call-1:enter',
  });

  // Another session: forwarded by id; its busy refusal keeps code and reason.
  refuse = () => {
    throw worktreeError('WORKTREE_BUSY_JOBS', 'The session is running a turn; wait for it to finish.', {
      reason: 'turn',
    });
  };
  const busy = json(
    await executeGitTool(
      { action: 'worktree', worktree_action: 'merge', session_id: 'sess_other' },
      repo,
      asLead
    )
  );
  assert.equal(calls.at(-1).request.sessionId, 'sess_other');
  assert.equal(busy.code, 'WORKTREE_BUSY_JOBS');
  assert.equal(busy.details.reason, 'turn');
  assert.match(busy.next, /idle/);

  for (const [args, pattern] of [
    [{ worktree_action: 'enter', create: true }, /create needs branch/],
    [{ worktree_action: 'enter', force: true }, /force applies to worktree_action remove/],
    [{ worktree_action: 'enter', branch: 'dev', carry: 'leave' }, /branch excludes name and carry/],
    [{ worktree_action: 'enter', carry: 'maybe' }, /carry must be leave or carry/],
    [{ worktree_action: 'list', session_id: 'sess_other' }, /session_id applies to/],
    [{ worktree_action: 'teleport' }, /requires worktree_action/],
    [{ worktree_action: 'enter', command: 'git status' }, /does not take command/],
  ]) {
    assert.match(await executeGitTool({ action: 'worktree', ...args }, repo, asLead), pattern, JSON.stringify(args));
  }
  assert.match(
    await executeGitTool({ command: 'git status', worktree_action: 'enter' }, repo, asLead),
    /worktree_action requires action:worktree/
  );
});
