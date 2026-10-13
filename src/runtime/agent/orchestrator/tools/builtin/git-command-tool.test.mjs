import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _gitCommandInternals } from './git-command-tool.mjs';
import { gitRepoLockKey } from './git-repo-rw-lock.mjs';
import { createDiffSnapshot } from './git-partial-stage.mjs';

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

test('git line caps include blank lines, retain headers, and count all omissions', () => {
  const { commandResult } = _gitCommandInternals;
  assert.equal(
    commandResult(plan, result('a\n\nb\nc\n'), 2).text,
    'a\n\n... [2 more lines omitted; raise output_limit or narrow the command]'
  );
  assert.equal(
    commandResult(plan, result(patch), 4).text,
    `${patch.split('\n').slice(0, 4).join('\n')}\n... [6 more lines omitted; raise output_limit or narrow the command]`
  );
  assert.equal(commandResult(plan, result('a\nb\n'), 2).text, 'a\nb\n');
});

test('stage discovery lists every change independently of the body cap and retains raw body', () => {
  const snapshot = createDiffSnapshot({
    repo: process.cwd(),
    scope: process.cwd(),
    plan,
    argv: ['diff'],
    raw: patch.trimEnd(),
  });
  assert.equal(snapshot.changes.length, 2);
  const text = _gitCommandInternals.stageableDiffResult(plan, result(patch), snapshot, 50).text;
  const manifest = `diff_id: ${snapshot.diffId}\nfile: "a.txt"\n${snapshot.changes
    .map((change) => `change:${change.id} @@ -${change.old_start},1 +${change.new_start},1 @@`)
    .join('\n')}`;
  assert.equal(text, `${patch}${manifest}`);
  const capped = _gitCommandInternals.stageableDiffResult(plan, result(patch), snapshot, 4).text;
  assert.equal(
    capped,
    `${patch.split('\n').slice(0, 4).join('\n')}\n... [6 more lines omitted; raise output_limit or narrow the command]\n${manifest}`
  );
});

test('a one-line body cap still lists edit groups, whole files and new files exactly once', () => {
  const raw =
    `${patch}diff --git a/mode.txt b/mode.txt\nold mode 100644\nnew mode 100755\n` +
    'diff --git a/new file.txt b/new file.txt\nnew file mode 100644\n--- /dev/null\n+++ b/new file.txt\t\n@@ -0,0 +1 @@\n+new\n';
  const snapshot = createDiffSnapshot({ repo: process.cwd(), scope: process.cwd(), plan, argv: ['diff'], raw });
  assert.equal(snapshot.changes.length, 4);
  const text = _gitCommandInternals.stageableDiffResult(plan, result(raw), snapshot, 1).text;
  const ids = [...text.matchAll(/^change:(chg_[0-9a-f]{16}) /gm)].map((match) => match[1]);
  assert.deepEqual(
    ids,
    snapshot.changes.map(({ id }) => id)
  );
  assert.match(text, /file: "mode.txt"\nchange:\S+ file/);
  assert.match(text, /file: "new file.txt"\nchange:\S+ new_file/);
  assert.doesNotMatch(text, /changes omitted/);
});

test('a diff with no selectable changes has no staging metadata', () => {
  const raw = 'diff --git a/a.bin b/a.bin\nBinary files a/a.bin and b/a.bin differ\n';
  const snapshot = createDiffSnapshot({ repo: process.cwd(), scope: process.cwd(), plan, argv: ['diff'], raw });
  assert.equal(_gitCommandInternals.stageableDiffResult(plan, result(raw), snapshot, 50).text, raw);
});

test('grouped manifests preserve every ID, path and location including escaped filenames', () => {
  const paths = ['한글 file.txt', 'quote"file.txt', 'line\nbreak.txt', 'back\\slash.txt'];
  const changes = paths.flatMap((path, file) =>
    Array.from({ length: 5 }, (_, i) => ({
      path,
      id: `chg_${file}_${i}`,
      old_start: i + 1,
      new_start: i + 2,
      deletions: i,
      additions: i + 1,
    }))
  );
  const snapshot = { diffId: 'diff_lossless', changes };
  const text = _gitCommandInternals.stageableDiffResult(plan, result('body\n'), snapshot, 1).text;
  const decoded = [];
  let path;
  for (const line of text.split('\n')) {
    if (line.startsWith('file: ')) path = JSON.parse(line.slice(6));
    const match = /^change:(\S+) (.+)$/.exec(line);
    if (match) decoded.push({ id: match[1], path, location: match[2] });
  }
  assert.deepEqual(
    decoded,
    changes.map((change) => ({
      id: change.id,
      path: change.path,
      location: `@@ -${change.old_start},${change.deletions} +${change.new_start},${change.additions} @@`,
    }))
  );
  assert.equal(text.split('\nfile: ').length - 1, paths.length);
  assert.ok(text.startsWith('body\ndiff_id: diff_lossless\n'));
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
