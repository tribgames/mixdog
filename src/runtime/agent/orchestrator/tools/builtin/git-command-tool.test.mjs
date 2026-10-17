import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _gitCommandInternals } from './git-command-tool.mjs';
import { gitRepoLockKey } from './git-repo-rw-lock.mjs';
import { createDiffSnapshot } from './git-partial-stage.mjs';

const NOTE = 'ids number the +/- runs in diff order; [whole file] ids stage the entire file';
const plan = { operation: 'diff', cwd: process.cwd(), args: [], globalArgs: [] };
const result = (stdout, stderr = '', exitCode = 0) => ({ stdout, stderr, exitCode });
const patch =
  'diff --git a/a.txt b/a.txt\nindex 123..456 100644\n--- a/a.txt\n+++ b/a.txt\n@@ -1,3 +1,3 @@\n-old\n+new\n context\n-before\n+after\n';

test('git single output preserves whitespace, JSON-looking blobs and stderr', () => {
  const { commandResult } = _gitCommandInternals;
  for (const text of ['', '  M a.txt\n', '{"ok":false}\n', 'x\r\n\n', 'x'.repeat(5000)]) {
    assert.deepEqual(commandResult(plan, result(text), 50), { text, failed: false });
  }
  assert.equal(commandResult(plan, result('out', 'warning\n'), 50).text, 'out\nwarning\n');
  assert.equal(commandResult(plan, result('out\n', 'fatal\n', 128), 50).text, 'exit 128\nout\nfatal\n');
  assert.equal(commandResult(plan, { ...result(''), timedOut: true }, 50).text, 'error: git command timed out');
});

// The body as the model sees it: `index abc..def` lines are dropped.
const shownPatch = patch.replace(/^index .*\n/m, '');
const HINT =
  'hint: large diff - run with --stat first for per-file sizes, add -U1 for less context, and page by file with -- <path>';
const HINT_RE = new RegExp(`\\n${HINT.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`);

test('git line caps include blank lines, retain headers, and count all omissions', () => {
  const { commandResult } = _gitCommandInternals;
  assert.equal(
    commandResult(plan, result('a\n\nb\nc\n'), 2).text,
    'a\n\n... [2 more lines omitted; raise output_limit or narrow the command]'
  );
  const capped = commandResult(plan, result(patch), 4).text;
  assert.equal(
    capped.replace(HINT_RE, ''),
    `${shownPatch.split('\n').slice(0, 4).join('\n')}\n... [5 more lines omitted; raise output_limit or narrow the command]`
  );
  assert.match(capped, HINT_RE);
  assert.equal(commandResult(plan, result('a\nb\n'), 2).text, 'a\nb\n');
});

test('stage discovery lists one id range per file independently of the body cap and retains the body', () => {
  const snapshot = createDiffSnapshot({
    repo: process.cwd(),
    scope: process.cwd(),
    plan,
    argv: ['diff'],
    raw: patch.trimEnd(),
  });
  assert.deepEqual(
    snapshot.changes.map(({ id }) => id),
    ['c1', 'c2']
  );
  const text = _gitCommandInternals.stageableDiffResult(plan, result(patch), snapshot, 50).text;
  const manifest = `diff_id: ${snapshot.diffId} (${NOTE})\na.txt: c1-c2`;
  assert.equal(text, `${shownPatch}${manifest}`);
  const capped = _gitCommandInternals.stageableDiffResult(plan, result(patch), snapshot, 4).text;
  assert.equal(
    capped,
    `${shownPatch.split('\n').slice(0, 4).join('\n')}\n... [5 more lines omitted; raise output_limit or narrow the command]\n${HINT}\n${manifest}`
  );
});

test('index lines and line-ending warnings are dropped; content that merely looks like them is kept', () => {
  const { commandResult } = _gitCommandInternals;
  const warning = "warning: in the working copy of 'a.txt', LF will be replaced by CRLF the next time Git touches it\n";
  assert.equal(commandResult(plan, result(patch, warning), 50).text, shownPatch);
  assert.equal(
    commandResult({ operation: 'add' }, result('', `${warning}warning: other thing\n`), 50).text,
    'warning: other thing\n'
  );
  assert.equal(
    commandResult(
      { operation: 'add' },
      result('', "warning: in the working copy of 'b.txt', CRLF will be replaced by LF the next time Git touches it\n"),
      50
    ).text,
    ''
  );
  // Not a patch: a blob that contains an index-looking line is returned verbatim.
  const blob = 'index abc..def 100644\nbody\n';
  assert.equal(commandResult({ operation: 'show' }, result(blob), 50).text, blob);
  // A diff content line is prefixed, so it is never mistaken for a header.
  const withContent = `${shownPatch}+index abc..def\n`;
  assert.equal(commandResult(plan, result(`${patch}+index abc..def\n`), 50).text, withContent);
  // A warning-only stderr no longer hides a diff --quiet exit signal.
  assert.equal(
    commandResult({ operation: 'diff', args: ['--quiet'] }, result('', warning, 1), 50).text,
    'exit 1\n[outcome: no-match]'
  );
});

test('large diffs get a one-line paging hint; stat-style and small output do not', () => {
  const { commandResult } = _gitCommandInternals;
  const bigPatch = `diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1,300 +1,300 @@\n${Array.from(
    { length: 300 },
    (_, index) => `+line ${index}`
  ).join('\n')}\n`;
  // Over ~200 lines even when the caller's cap lets all of it through.
  const whole = commandResult(plan, result(bigPatch), 500).text;
  assert.equal([...whole.matchAll(/^hint: /gm)].length, 1);
  assert.match(whole, HINT_RE);
  assert.doesNotMatch(commandResult(plan, result(shownPatch), 50).text, /hint:/);
  const stat = ' a.txt | 300 ++++\n 1 file changed, 300 insertions(+)\n';
  assert.doesNotMatch(commandResult({ operation: 'diff', args: ['--stat'] }, result(stat), 1).text, /hint:/);
});

test('output is also capped by characters per command and says what was cut and how to page', () => {
  const { commandResult } = _gitCommandInternals;
  const lines = Array.from({ length: 400 }, (_, index) => `${String(index).padStart(3, '0')} ${'x'.repeat(96)}`);
  const text = `${lines.join('\n')}\n`;
  const defaultCap = commandResult({ operation: 'log' }, result(text), 500).text;
  assert.ok(defaultCap.length < 12_500, String(defaultCap.length));
  assert.match(
    defaultCap,
    /\n\.\.\. \[\d+ more lines \(\d+ chars\) omitted; output limited to 12000 chars - narrow the command \(-- <path>, -n\/--skip\) to page\]$/
  );
  // Cut on a line boundary: the last shown line is whole.
  const shown = defaultCap.split('\n').slice(0, -1);
  assert.ok(shown.every((line) => line.length === 100));
  const omitted = Number(/\[(\d+) more lines/.exec(defaultCap)[1]);
  assert.equal(shown.length + omitted, 400);
  // The array-wide share arrives as a smaller per-command budget.
  const share = commandResult({ operation: 'log' }, result(text), { lines: 500, chars: 2000 }).text;
  assert.match(share, /output limited to 2000 chars/);
  assert.ok(share.length < 2300);
  // A single over-long line is still cut.
  assert.match(
    commandResult({ operation: 'log' }, result('y'.repeat(30_000)), { lines: 50, chars: 1000 }).text,
    /^y{1000}\n\.\.\. \[0 more lines \(29000 chars\) omitted;/
  );
  // Under both caps the text is untouched.
  assert.equal(commandResult({ operation: 'log' }, result(text.slice(0, 5000)), 500).text, text.slice(0, 5000));
});

test('merge-tree conflicts are an outcome, not a failure; Auto-merging lines go', () => {
  const { commandResult } = _gitCommandInternals;
  const tree = 'a'.repeat(40);
  const report = `${tree}\n100644 ${'b'.repeat(40)} 1\tclash.txt\n\nAuto-merging clash.txt\nAuto-merging quiet.txt\nCONFLICT (content): Merge conflict in clash.txt\n`;
  const conflicted = commandResult({ operation: 'merge-tree', args: [] }, result(report, '', 1), 50);
  assert.equal(conflicted.failed, false);
  assert.match(conflicted.text, /^exit 1\n\[outcome: conflicts\]\nmerge has conflicts \(see the CONFLICT lines\)/);
  assert.match(conflicted.text, new RegExp(tree));
  assert.match(conflicted.text, /CONFLICT \(content\): Merge conflict in clash\.txt/);
  assert.match(conflicted.text, /clash\.txt/);
  assert.doesNotMatch(conflicted.text, /Auto-merging/);
  // exit 1 without a report, or with stderr, is an ordinary failure.
  assert.deepEqual(commandResult({ operation: 'merge-tree', args: [] }, result('', '', 1), 50), {
    text: 'exit 1',
    failed: true,
  });
  assert.equal(commandResult({ operation: 'merge-tree', args: [] }, result(report, 'fatal: x\n', 1), 50).failed, true);
  // Success also loses the Auto-merging lines.
  assert.equal(
    commandResult({ operation: 'merge-tree', args: [] }, result(`${tree}\nAuto-merging a\n`), 50).text,
    `${tree}\n`
  );
});

test('a one-line body cap still lists edit groups, whole files and new files exactly once', () => {
  const raw =
    `${patch}diff --git a/mode.txt b/mode.txt\nold mode 100644\nnew mode 100755\n` +
    'diff --git a/new file.txt b/new file.txt\nnew file mode 100644\n--- /dev/null\n+++ b/new file.txt\t\n@@ -0,0 +1 @@\n+new\n';
  const snapshot = createDiffSnapshot({ repo: process.cwd(), scope: process.cwd(), plan, argv: ['diff'], raw });
  assert.equal(snapshot.changes.length, 4);
  const text = _gitCommandInternals.stageableDiffResult(plan, result(raw), snapshot, 1).text;
  assert.deepEqual(
    snapshot.changes.map(({ id }) => id),
    ['c1', 'c2', 'c3', 'c4']
  );
  assert.match(text, /\na\.txt: c1-c2\nmode\.txt: c3 \[whole file\]\nnew file\.txt: c4 \[whole file\]$/);
  assert.doesNotMatch(text, /changes omitted|^change:|^file:/m);
});

test('a diff with no selectable changes has no staging metadata', () => {
  const raw = 'diff --git a/a.bin b/a.bin\nBinary files a/a.bin and b/a.bin differ\n';
  const snapshot = createDiffSnapshot({ repo: process.cwd(), scope: process.cwd(), plan, argv: ['diff'], raw });
  assert.equal(_gitCommandInternals.stageableDiffResult(plan, result(raw), snapshot, 50).text, raw);
});

test('grouped listings keep every id range and path, quoting only names that would break a line', () => {
  const paths = ['한글 file.txt', 'quote"file.txt', 'line\nbreak.txt', 'back\\slash.txt', 'single.txt'];
  let ordinal = 0;
  const changes = paths.flatMap((path, file) =>
    Array.from({ length: file === 4 ? 1 : 5 }, () => ({ path, id: `c${++ordinal}` }))
  );
  const snapshot = { diffId: 'diff_lossless', changes };
  const text = _gitCommandInternals.stageableDiffResult(plan, result('body\n'), snapshot, 1).text;
  assert.equal(
    text,
    [
      'body',
      `diff_id: diff_lossless (${NOTE})`,
      '한글 file.txt: c1-c5',
      `${JSON.stringify('quote"file.txt')}: c6-c10`,
      `${JSON.stringify('line\nbreak.txt')}: c11-c15`,
      'back\\slash.txt: c16-c20',
      'single.txt: c21',
    ].join('\n')
  );
});

test('the repository lock key is the common git dir shared by the main checkout and linked worktrees', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-git-lock-key-'));
  try {
    const repo = join(root, 'repo');
    const linked = join(root, 'linked');
    const git = (cwd, ...args) => execFileSync('git', args, { cwd, stdio: 'pipe', windowsHide: true });
    mkdirSync(repo);
    git(repo, 'init', '-q', '-b', 'main');
    git(repo, '-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '--allow-empty', '-m', 'init');
    git(repo, 'worktree', 'add', '-q', '-b', 'side', linked);
    const resolveFrom = (cwd) =>
      _gitCommandInternals.resolveRepo({ operation: 'status', cwd, args: [], globalArgs: [] }, null);
    const main = await resolveFrom(repo);
    const side = await resolveFrom(linked);
    assert.notEqual(main.root, side.root);
    assert.equal(main.lockKey, side.lockKey);
    assert.equal(main.lockKey, gitRepoLockKey(join(repo, '.git')));
    // A cache hit answers with the same key.
    assert.equal((await resolveFrom(linked)).lockKey, side.lockKey);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
