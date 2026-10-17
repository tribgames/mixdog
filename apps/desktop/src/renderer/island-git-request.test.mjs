import assert from 'node:assert/strict';
import test from 'node:test';
import { buildIslandGitRequest, parseIslandGitRequestText, sendIslandGitRequest } from './island-git-request';

const rows = [
  { path: 'src/a.ts', status: 'M', additions: 3, deletions: 1 },
  { path: 'src/b.ts', status: 'A', additions: 10, deletions: 0 },
];
const status = {
  repository: true,
  branch: 'main',
  detached: false,
  upstream: true,
  upstreamName: 'origin/main',
  ahead: 2,
  behind: 0,
  remoteUrl: 'git@example.com:o/r.git',
};
const base = {
  source: 'session',
  rows,
  status,
  defaultBranch: 'main',
  gh: { installed: true, authenticated: true, login: 'me' },
};

test('each action builds a card and hidden context with its instructions', () => {
  const pr = buildIslandGitRequest({ ...base, action: 'pr' });
  assert.equal(pr.label, 'Create PR');
  assert.equal(pr.meta, 'Current session · Files 2');
  assert.deepEqual(parseIslandGitRequestText(pr.displayText), {
    action: 'pr',
    label: 'Create PR',
    meta: 'Current session · Files 2',
  });
  assert.ok(!pr.displayText.includes('src/a.ts'));
  assert.match(pr.content, /- M src\/a\.ts \(\+3 -1\)/);
  assert.match(pr.content, /Upstream: origin\/main; ahead 2, behind 0/);
  assert.match(pr.content, /Default\/base branch: main/);
  assert.match(pr.content, /GitHub CLI: authenticated as me/);
  assert.match(pr.content, /Remote: git@example\.com:o\/r\.git/);
  assert.match(pr.content, /by work unit/);
  assert.match(pr.content, /scratch files/);
  assert.match(pr.content, /create a new, descriptively named branch before committing/);
  assert.match(pr.content, /gh pr create/);
  assert.match(pr.content, /link/);

  const onFeature = buildIslandGitRequest({ ...base, action: 'pr', status: { ...status, branch: 'feat/x' } });
  assert.match(onFeature.content, /Commit on the current branch/);

  const push = buildIslandGitRequest({
    ...base,
    action: 'commit-push',
    source: 'staged',
    status: { ...status, upstream: false, upstreamName: '' },
  });
  assert.equal(push.label, 'Commit · push');
  assert.equal(push.meta, 'Staged · Files 2');
  assert.match(push.content, /git push -u/);
  assert.doesNotMatch(push.content, /gh pr create/);

  const commit = buildIslandGitRequest({ ...base, action: 'commit', source: 'branch' });
  assert.equal(commit.label, 'Commit');
  assert.equal(commit.meta, 'This branch · Files 2');
  assert.match(commit.content, /Do not push/);
});

const patch = (body) => `diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n${body}\n`;
const context = {
  statusShort: '## main...origin/main [ahead 2]\n M src/a.ts',
  diffStat: ' src/a.ts | 4 ++--',
  files: [
    { path: 'src/a.ts', patch: patch('+small'), truncated: false },
    { path: 'src/b.ts', patch: patch('+'.padEnd(9000, 'x')), truncated: false },
    { path: 'package-lock.json', patch: patch('+lock'), truncated: false },
    { path: 'img.png', patch: 'Binary files a/img.png and b/img.png differ\n', truncated: false },
  ],
  recentSubjects: ['feat: one', 'fix: two'],
  branchCommits: 'abc1234 feat: x',
  branchDiffStat: ' src/a.ts | 4 ++--',
  pr: null,
};

test('context blocks are embedded within the caps', () => {
  const allRows = [
    ...rows,
    { path: 'package-lock.json', status: 'M', additions: 5, deletions: 5 },
    { path: 'img.png', status: 'A', additions: 0, deletions: 0 },
  ];
  const { content } = buildIslandGitRequest({ ...base, action: 'pr', rows: allRows, context });
  assert.match(content, /git status --short --branch:\n## main\.\.\.origin\/main/);
  assert.match(content, /git diff HEAD --stat:\n src\/a\.ts/);
  assert.match(content, /### src\/a\.ts\n```diff\n[\s\S]*\+small/);
  assert.match(content, /### package-lock\.json: summarized/);
  assert.match(content, /### img\.png: summarized/);
  assert.match(content, /\(truncated above, \+10 -0; read this file's diff/);
  assert.ok(!content.includes('x'.repeat(4100)), 'per-file cap');
  assert.match(content, /git log --oneline base\.\.HEAD\):\nabc1234 feat: x/);
  assert.match(content, /- feat: one\n- fix: two/);
  assert.match(content, /Pull request for the current branch: none/);
  assert.match(content, /do not re-run git status\/diff\/log or gh pr view; use only git and gh/);
  const withPr = buildIslandGitRequest({
    ...base,
    action: 'commit',
    context: {
      ...context,
      branchCommits: '',
      branchDiffStat: '',
      pr: { number: 7, title: 'T', url: 'https://x/pull/7', state: 'OPEN', baseRefName: 'main' },
    },
  }).content;
  assert.match(withPr, /#7 "T" https:\/\/x\/pull\/7 \(OPEN, base main\)/);
  assert.doesNotMatch(withPr, /base\.\.HEAD/);
});

test('the total patch budget omits later files', () => {
  const many = Array.from({ length: 10 }, (_, i) => ({
    path: `f${i}.ts`,
    patch: patch('+'.padEnd(5000, 'y')),
    truncated: false,
  }));
  const { content } = buildIslandGitRequest({
    ...base,
    action: 'commit',
    rows: many.map((f) => ({ path: f.path, status: 'M', additions: 1, deletions: 0 })),
    context: { ...context, files: many },
  });
  assert.match(content, /### f9\.ts: omitted \(patch budget used\)/);
  assert.ok(content.length < 40_000);
});

test('the base ref is read for PRs and non-default branches only', async () => {
  const { islandGitBaseRef } = await import('./island-git-request');
  assert.equal(islandGitBaseRef('pr', { branch: 'main', detached: false }, 'main'), 'origin/main');
  assert.equal(islandGitBaseRef('commit', { branch: 'main', detached: false }, 'main'), '');
  assert.equal(islandGitBaseRef('commit', { branch: 'f', detached: false }, 'main'), 'origin/main');
  assert.equal(islandGitBaseRef('pr', { branch: '', detached: true }, 'main'), '');
});

test('plain user text is not a request card', () => {
  assert.equal(parseIslandGitRequestText('Create PR\nCurrent session · Files 2'), null);
});

test('the request goes through the session submit path with hidden content', async () => {
  const sent = [];
  const accepted = await sendIslandGitRequest({
    host: {
      gitStatus: async () => status,
      ghPrDefaultBranch: async () => 'main',
      githubCliStatus: async () => ({ installed: true, authenticated: false }),
      submitToSession: async (sessionId, content, options) => {
        sent.push({ sessionId, content, options });
        return true;
      },
    },
    sessionId: 's1',
    cwd: '/repo',
    action: 'commit',
    source: 'unstaged',
    rows,
  });
  assert.equal(accepted, true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].sessionId, 's1');
  assert.match(sent[0].content, /installed, not authenticated/);
  assert.equal(parseIslandGitRequestText(sent[0].options.displayText).action, 'commit');
  assert.ok(sent[0].options.id);
  assert.notEqual(sent[0].options.displayText, sent[0].content);
});

test('a folder that is not a repository sends nothing', async () => {
  let called = false;
  const accepted = await sendIslandGitRequest({
    host: {
      gitStatus: async () => ({ repository: false }),
      submitToSession: async () => {
        called = true;
        return true;
      },
    },
    sessionId: 's1',
    cwd: '/x',
    action: 'pr',
    source: 'session',
    rows,
  });
  assert.equal(accepted, false);
  assert.equal(called, false);
});
