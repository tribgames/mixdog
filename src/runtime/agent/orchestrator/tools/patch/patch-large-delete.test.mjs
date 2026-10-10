// apply_patch on binary / oversized targets: a Delete File runs without ever
// reading the file (quarantine rename, atomic with the rest of the batch), a
// content edit is refused before any mutation, and replay / review report the
// omitted bytes honestly instead of as empty content.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import fs, {
  appendFileSync,
  chmodSync,
  closeSync,
  existsSync,
  ftruncateSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { parsePatch } from 'diff';

import { createSnapshotBudget, PATCH_SNAPSHOT_MAX_BYTES } from '../../../../shared/bounded-file-read.mjs';
import {
  _resetTurnSnapshotForTest,
  beginTurnSnapshot,
  getTurnReviewDiff,
  revertTurnReview,
  revertTurnReviewFile,
} from '../../../../shared/turn-snapshot.mjs';
import { executePatchTool } from '../patch.mjs';
import { applyCodexBatchWithRollback } from './apply-patch/codex-batch.mjs';
import { quarantineDeleteTargets } from './delete-quarantine.mjs';
import { dispatchJsPatchEntries } from './dispatch.mjs';
import { closeNativePatchServerForTests } from './native-server.mjs';
import { classifyEntry } from './paths.mjs';
import { maybeCapturePatchReplay, preparePatchReplayCapture, setPatchReplayPreSnapshots } from './replay-capture.mjs';
import { capturePatchRollbackState, restorePatchRollbackState } from './rollback-state.mjs';
import { registerCommittedPatchUiDiff } from './ui-diff.mjs';
import { applyParsedWave } from './wave.mjs';

const BIG_BYTES = 12 * 1024 * 1024;
const asHeader = (path) => path.replace(/\\/g, '/');

function makeDir(t) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'mixdog-large-delete-')));
  t.after(() => {
    rmSync(dir, { recursive: true, force: true });
    void closeNativePatchServerForTests?.();
  });
  return dir;
}

// A random head plus a sparse tail: binary, larger than 8 MiB, cheap to make.
function writeLargeBinary(path) {
  const fd = openSync(path, 'w');
  try {
    writeSync(fd, randomBytes(64 * 1024));
    ftruncateSync(fd, BIG_BYTES);
  } finally {
    closeSync(fd);
  }
}

// A Git repository in `dir` with a committer identity; returns a git runner.
function initGitRepo(dir) {
  const git = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' }).toString();
  git('init', '--initial-branch=main');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Large Delete Test');
  return git;
}

const sha256 = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');
const quarantineLeftovers = (dir) => readdirSync(dir).filter((name) => name.includes('.mixdog-delete-'));

// Observes every read of `target` through node:fs while a patch runs: whole-file
// reads are recorded by name, bounded reads by the bytes pulled through fds
// opened on it.
function watchReads(target) {
  const key = resolve(target).toLowerCase();
  const matches = (path) => typeof path === 'string' && resolve(path).toLowerCase() === key;
  const real = {
    readFileSync: fs.readFileSync,
    readFile: fs.readFile,
    promisesReadFile: fs.promises.readFile,
    openSync: fs.openSync,
    readSync: fs.readSync,
    closeSync: fs.closeSync,
    appendFileSync: fs.appendFileSync,
  };
  // fd -> bytes read through it; maxFdBytes is the largest single bounded read.
  const fds = new Map();
  const stats = { fullReads: [], boundedBytes: 0, maxFdBytes: 0 };
  fs.readFileSync = function (path, ...rest) {
    if (matches(path)) stats.fullReads.push('readFileSync');
    return real.readFileSync.call(this, path, ...rest);
  };
  fs.readFile = function (path, ...rest) {
    if (matches(path)) stats.fullReads.push('readFile');
    return real.readFile.call(this, path, ...rest);
  };
  fs.promises.readFile = function (path, ...rest) {
    if (matches(path)) stats.fullReads.push('promises.readFile');
    return real.promisesReadFile.call(this, path, ...rest);
  };
  fs.openSync = function (path, ...rest) {
    const fd = real.openSync.call(this, path, ...rest);
    if (matches(path)) fds.set(fd, 0);
    return fd;
  };
  fs.readSync = function (fd, ...rest) {
    const read = real.readSync.call(this, fd, ...rest);
    if (fds.has(fd)) {
      stats.boundedBytes += read;
      fds.set(fd, fds.get(fd) + read);
      stats.maxFdBytes = Math.max(stats.maxFdBytes, fds.get(fd));
    }
    return read;
  };
  // Descriptor numbers are reused once closed.
  const closeSync = function (fd, ...rest) {
    fds.delete(fd);
    return real.closeSync.call(this, fd, ...rest);
  };
  fs.closeSync = closeSync;
  syncBuiltinESMExports();
  return {
    stats,
    real,
    fds,
    closeSync,
    stop() {
      fs.readFileSync = real.readFileSync;
      fs.readFile = real.readFile;
      fs.promises.readFile = real.promisesReadFile;
      fs.openSync = real.openSync;
      fs.readSync = real.readSync;
      fs.closeSync = real.closeSync;
      syncBuiltinESMExports();
    },
  };
}

// Holds `path` open from another process with the given FileShare mode
// ('None' denies reads too) until the test ends.
async function holdWindowsLock(t, path, share) {
  const holder = spawn(
    'powershell.exe',
    [
      '-NoProfile',
      '-Command',
      `$f=[IO.File]::Open('${path.replace(/'/g, "''")}','Open','Read','${share}'); 'locked'; Start-Sleep 60`,
    ],
    { stdio: ['ignore', 'pipe', 'inherit'] }
  );
  t.after(() => holder.kill());
  await new Promise((resolveLock, reject) => {
    holder.stdout.on('data', (chunk) => {
      if (String(chunk).includes('locked')) resolveLock();
    });
    holder.once('exit', (code) => reject(new Error(`lock holder exited early (${code})`)));
  });
  return holder;
}

async function patch(body, cwd, basePath = cwd, options = {}) {
  return String(await executePatchTool('apply_patch', { base_path: basePath, patch: body }, cwd, options));
}

test('a large binary Delete File (native route, non-Git cwd) deletes without reading the file', async (t) => {
  const dir = makeDir(t);
  const big = join(dir, 'best_soft_nll.pt');
  writeLargeBinary(big);
  const watch = watchReads(big);
  let result;
  try {
    result = await patch('*** Begin Patch\n*** Delete File: best_soft_nll.pt\n*** End Patch\n', dir);
  } finally {
    watch.stop();
  }
  assert.doesNotMatch(result, /^Error/);
  assert.match(result, /OK Delete .*best_soft_nll\.pt/);
  assert.equal(existsSync(big), false);
  assert.deepEqual(readdirSync(dir), []);
  assert.deepEqual(watch.stats.fullReads, []);
  assert.ok(
    watch.stats.boundedBytes <= 64 * 1024,
    `read ${watch.stats.boundedBytes} bytes of a ${BIG_BYTES}-byte file`
  );
});

test('large binary deletes in a Git cwd (ordered multi-file route) leave only Git deletions', async (t) => {
  const dir = makeDir(t);
  const git = initGitRepo(dir);
  writeLargeBinary(join(dir, 'a.pt'));
  writeLargeBinary(join(dir, 'b.pt'));
  git('add', '.');
  git('commit', '-m', 'checkpoints');
  const result = await patch('*** Begin Patch\n*** Delete File: a.pt\n*** Delete File: b.pt\n*** End Patch\n', dir);
  assert.doesNotMatch(result, /^Error/);
  assert.equal(existsSync(join(dir, 'a.pt')), false);
  assert.equal(existsSync(join(dir, 'b.pt')), false);
  assert.deepEqual(quarantineLeftovers(dir), []);
  assert.deepEqual(git('status', '--porcelain').split('\n').filter(Boolean).sort(), [' D a.pt', ' D b.pt']);
});

test('a large binary delete outside base_path (JS route) is deleted too', async (t) => {
  const dir = makeDir(t);
  const base = join(dir, 'app');
  const outside = join(dir, 'outside');
  mkdirSync(base);
  mkdirSync(outside);
  const big = join(outside, 'model.safetensors');
  writeLargeBinary(big);
  const result = await patch(`*** Begin Patch\n*** Delete File: ${asHeader(big)}\n*** End Patch\n`, base);
  assert.doesNotMatch(result, /^Error/);
  assert.equal(existsSync(big), false);
  assert.deepEqual(readdirSync(outside), []);
});

test('a later failure in the same batch restores the quarantined file byte-exactly', async (t) => {
  const dir = makeDir(t);
  const big = join(dir, 'big.bin');
  const small = join(dir, 'small.txt');
  writeLargeBinary(big);
  writeFileSync(small, 'before\n');
  const expected = sha256(big);
  const result = await applyCodexBatchWithRollback({
    batch: { lockPaths: [big, small], v4aRenamePlan: null, waveDispatch: [] },
    basePath: dir,
    dryRun: false,
    readStateScope: null,
    abortSignal: null,
    options: {},
    runBatch: async (quarantine) => {
      // The big file's snapshot is omitted, so its delete must take the quarantine.
      assert.equal(quarantine.omittedKeys.size, 1);
      quarantineDeleteTargets(quarantine, [{ fullPath: big, displayPath: 'big.bin' }]);
      assert.equal(existsSync(big), false);
      writeFileSync(small, 'after\n');
      return 'Error: simulated later failure';
    },
  });
  assert.match(result, /simulated later failure/);
  assert.match(result, /rolled back: every touched path was restored/);
  assert.equal(sha256(big), expected);
  assert.equal(readFileSync(small, 'utf8'), 'before\n');
  assert.deepEqual(readdirSync(dir).sort(), ['big.bin', 'small.txt']);
});

test('a locked file that cannot be moved aside fails the batch and rolls everything back', async (t) => {
  if (process.platform !== 'win32') {
    t.skip('mandatory file locks are a Windows behavior');
    return;
  }
  const dir = makeDir(t);
  const first = join(dir, 'a-big.bin');
  const locked = join(dir, 'z-locked.bin');
  const small = join(dir, 'small.txt');
  writeLargeBinary(first);
  writeLargeBinary(locked);
  writeFileSync(small, 'before\n');
  const firstHash = sha256(first);
  const lockedHash = sha256(locked);
  // Readers allowed, delete/rename sharing denied: only the move aside fails.
  const holder = await holdWindowsLock(t, locked, 'Read');
  const result = await patch(
    [
      '--- a/a-big.bin',
      '+++ /dev/null',
      '--- a/z-locked.bin',
      '+++ /dev/null',
      '--- a/small.txt',
      '+++ b/small.txt',
      '@@ -1 +1 @@',
      '-before',
      '+after',
      '',
    ].join('\n'),
    dir
  );
  holder.kill();
  assert.match(result, /^Error/);
  assert.match(result, /z-locked\.bin failed — it could not be moved aside/);
  assert.match(result, /rolled back: every touched path was restored/);
  assert.equal(sha256(first), firstHash);
  assert.equal(sha256(locked), lockedHash);
  assert.equal(readFileSync(small, 'utf8'), 'before\n');
  assert.deepEqual(quarantineLeftovers(dir), []);
});

test('content edits and renames of oversized or binary files are refused before any mutation', async (t) => {
  const dir = makeDir(t);
  const bigText = join(dir, 'big.txt');
  const small = join(dir, 'small.txt');
  const blob = join(dir, 'blob.bin');
  writeFileSync(bigText, 'line\n'.repeat((9 * 1024 * 1024) / 5));
  writeFileSync(small, 'before\n');
  writeFileSync(blob, Buffer.from([0x00, 0x01, 0x02, 0x00, 0x61, 0x0a]));
  const bigStat = statSync(bigText);

  const v4a = await patch('*** Begin Patch\n*** Update File: big.txt\n@@\n-line\n+LINE\n*** End Patch\n', dir);
  assert.match(v4a, /^Error/);
  assert.match(v4a, /larger than 8 MiB/);

  // Unified batch: the small edit is never applied because the big one is refused.
  const unified = await patch(
    [
      '--- a/small.txt',
      '+++ b/small.txt',
      '@@ -1 +1 @@',
      '-before',
      '+after',
      '--- a/big.txt',
      '+++ b/big.txt',
      '@@ -1 +1 @@',
      '-line',
      '+LINE',
      '',
    ].join('\n'),
    dir
  );
  assert.match(unified, /^Error/);
  assert.match(unified, /larger than 8 MiB/);
  assert.equal(readFileSync(small, 'utf8'), 'before\n');

  const rename = await patch(
    '*** Begin Patch\n*** Update File: blob.bin\n*** Move to: moved.bin\n*** End Patch\n',
    dir
  );
  assert.match(rename, /^Error/);
  assert.match(rename, /binary/);
  assert.equal(existsSync(join(dir, 'moved.bin')), false);

  const after = statSync(bigText);
  assert.equal(after.size, bigStat.size);
  assert.equal(after.mtimeMs, bigStat.mtimeMs);
  assert.deepEqual([...readFileSync(blob)], [0x00, 0x01, 0x02, 0x00, 0x61, 0x0a]);
});

test('rollback snapshots keep absent / empty / omitted distinct and never restore omitted bytes', async (t) => {
  const dir = makeDir(t);
  const big = join(dir, 'big.bin');
  const empty = join(dir, 'empty.txt');
  const gone = join(dir, 'gone.txt');
  writeLargeBinary(big);
  writeFileSync(empty, '');
  const [bigSnap, emptySnap, goneSnap] = capturePatchRollbackState([big, empty, gone]);
  assert.equal(bigSnap.omitted, true);
  assert.equal(bigSnap.content, null);
  assert.equal(bigSnap.existed, true);
  assert.equal(bigSnap.size, BIG_BYTES);
  assert.equal(emptySnap.omitted, undefined);
  assert.equal(emptySnap.content.length, 0);
  assert.deepEqual(goneSnap, { fullPath: gone, existed: false, content: null, mode: null });

  // Untouched: nothing to restore, nothing written.
  const mtime = statSync(big).mtimeMs;
  assert.deepEqual(restorePatchRollbackState([bigSnap]), []);
  assert.equal(statSync(big).mtimeMs, mtime);
  // Changed: reported as unrestorable, never overwritten with empty bytes.
  appendFileSync(big, 'tail');
  const errors = restorePatchRollbackState([bigSnap]);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /pre-patch content was not captured .*cannot be restored/);
  assert.equal(statSync(big).size, BIG_BYTES + 4);

  // The transaction budget omits what would overflow it.
  const files = ['a', 'b', 'c'].map((name) => {
    const path = join(dir, `${name}.txt`);
    writeFileSync(path, name.repeat(40));
    return path;
  });
  const budgeted = capturePatchRollbackState(files, { budget: createSnapshotBudget(100) });
  assert.deepEqual(
    budgeted.map((snapshot) => (snapshot.omitted ? snapshot.omittedReason : 'captured')),
    ['captured', 'captured', 'budget']
  );
});

test('replay capture records omitted and unreadable targets explicitly', async (t) => {
  const dir = makeDir(t);
  const replayDir = join(dir, 'replays');
  const previous = process.env.MIXDOG_PATCH_REPLAY_DIR;
  process.env.MIXDOG_PATCH_REPLAY_DIR = replayDir;
  t.after(() => {
    if (previous === undefined) delete process.env.MIXDOG_PATCH_REPLAY_DIR;
    else process.env.MIXDOG_PATCH_REPLAY_DIR = previous;
  });
  writeLargeBinary(join(dir, 'big.bin'));
  writeFileSync(join(dir, 'empty.txt'), '');
  const body =
    '*** Begin Patch\n*** Delete File: big.bin\n*** Delete File: empty.txt\n*** Delete File: gone.txt\n*** End Patch\n';
  const capture = preparePatchReplayCapture({ patch: body }, dir, {});
  setPatchReplayPreSnapshots(
    capture,
    capturePatchRollbackState(['big.bin', 'empty.txt', 'gone.txt'].map((name) => join(dir, name)))
  );
  assert.deepEqual(capture.fileSnapshots, { 'big.bin': null, 'empty.txt': '', 'gone.txt': null });
  assert.deepEqual(capture.fileSnapshotMeta, { 'big.bin': { omitted: true, reason: 'oversized', size: BIG_BYTES } });

  maybeCapturePatchReplay(capture, 'Error: simulated');
  const [recordFile] = readdirSync(replayDir);
  const record = JSON.parse(readFileSync(join(replayDir, recordFile), 'utf8'));
  assert.equal(record.file_snapshots['big.bin'], null);
  assert.equal(record.file_snapshots['empty.txt'], '');
  assert.deepEqual(record.file_snapshot_meta, { 'big.bin': { omitted: true, reason: 'oversized', size: BIG_BYTES } });

  // Post-failure capture (no pre-state) reads boundedly and marks the same way.
  const post = preparePatchReplayCapture({ patch: body }, dir, {});
  maybeCapturePatchReplay(post, 'Error: simulated again');
  assert.deepEqual(post.fileSnapshotMeta, { 'big.bin': { omitted: true, reason: 'oversized', size: BIG_BYTES } });
  assert.equal(post.fileSnapshots['empty.txt'], '');
});

test('replay capture marks a target it cannot open as unreadable, not absent or empty', async (t) => {
  const dir = makeDir(t);
  const previous = process.env.MIXDOG_PATCH_REPLAY_DIR;
  process.env.MIXDOG_PATCH_REPLAY_DIR = join(dir, 'replays');
  t.after(() => {
    if (previous === undefined) delete process.env.MIXDOG_PATCH_REPLAY_DIR;
    else process.env.MIXDOG_PATCH_REPLAY_DIR = previous;
  });
  const locked = join(dir, 'locked.txt');
  writeFileSync(locked, 'secret\n');
  let release;
  if (process.platform === 'win32') {
    const holder = await holdWindowsLock(t, locked, 'None'); // no sharing: every open fails
    release = async () => {
      holder.kill();
      if (holder.exitCode === null) await new Promise((done) => holder.once('exit', done));
    };
  } else {
    chmodSync(locked, 0o000);
    release = async () => chmodSync(locked, 0o600);
  }
  const body = '*** Begin Patch\n*** Update File: locked.txt\n@@\n-secret\n+public\n*** End Patch\n';
  const capture = preparePatchReplayCapture({ patch: body }, dir, {});
  try {
    try {
      readFileSync(locked);
      t.skip('the file is still readable here (e.g. running as root)');
      return;
    } catch {
      // Expected: the lock/permission makes the file unreadable, which is the setup under test.
    }
    maybeCapturePatchReplay(capture, 'Error: simulated');
  } finally {
    // Released before the directory cleanup removes the file.
    await release();
  }
  assert.deepEqual(capture.fileSnapshots, { 'locked.txt': null });
  assert.deepEqual(capture.fileSnapshotMeta, { 'locked.txt': { unreadable: true } });
});

// Grows `target` to a 12 MiB text file the first time a descriptor opened on
// it is closed — i.e. right after the first (preflight) read — and records
// every read of it from then on.
function growAfterFirstRead(target) {
  const watch = watchReads(target);
  const realClose = watch.real.closeSync;
  let grown = false;
  fs.closeSync = function (fd, ...rest) {
    const watched = watch.fds.has(fd);
    const out = watch.closeSync.call(this, fd, ...rest);
    if (watched && !grown) {
      grown = true;
      watch.real.appendFileSync(target, Buffer.alloc(BIG_BYTES, 0x78));
    }
    return out;
  };
  syncBuiltinESMExports();
  return {
    stats: watch.stats,
    stop() {
      fs.closeSync = realClose;
      watch.stop();
    },
  };
}

test('a target that grows after the edit guard is refused by every consuming reader, never read whole', async (t) => {
  const dir = makeDir(t);
  const target = join(dir, 'target.txt');
  writeFileSync(target, 'before\n');
  const parsed = parsePatch('--- a/target.txt\n+++ b/target.txt\n@@ -1 +1 @@\n-before\n+after\n');
  const wave = {
    parsed,
    entries: [{ kind: classifyEntry(parsed[0]), fullPath: target, displayPath: 'target.txt' }],
    headerRewrites: [],
  };
  const grow = growAfterFirstRead(target);
  let result;
  try {
    result = await applyParsedWave(wave, dir, {});
  } finally {
    grow.stop();
  }
  assert.match(result.error, /larger than 8 MiB/);
  assert.deepEqual(grow.stats.fullReads, []);
  assert.ok(grow.stats.maxFdBytes <= PATCH_SNAPSHOT_MAX_BYTES + 1, `one read pulled ${grow.stats.maxFdBytes} bytes`);
  assert.equal(statSync(target).size, 7 + BIG_BYTES);
  assert.equal(readFileSync(target).subarray(0, 7).toString(), 'before\n');
});

test('the JS update writer refuses an oversized target at its own read', async (t) => {
  const dir = makeDir(t);
  const target = join(dir, 'target.txt');
  writeFileSync(target, Buffer.concat([Buffer.from('before\n'), Buffer.alloc(BIG_BYTES, 0x78)]));
  const parsed = parsePatch('--- a/target.txt\n+++ b/target.txt\n@@ -1 +1 @@\n-before\n+after\n');
  const watch = watchReads(target);
  let result;
  try {
    result = await dispatchJsPatchEntries({
      rows: [{ kind: classifyEntry(parsed[0]), fullPath: target, displayPath: 'target.txt' }],
      parsed,
      basePath: dir,
    });
  } finally {
    watch.stop();
  }
  assert.match(result, /^Error/);
  assert.match(result, /larger than 8 MiB/);
  assert.deepEqual(watch.stats.fullReads, []);
  assert.ok(watch.stats.maxFdBytes <= PATCH_SNAPSHOT_MAX_BYTES + 1);
  assert.equal(readFileSync(target).subarray(0, 7).toString(), 'before\n');
});

test('a large untracked delete in a Git cwd is reviewed as omitted and its revert is refused', async (t) => {
  const dir = makeDir(t);
  t.after(() => _resetTurnSnapshotForTest());
  const git = initGitRepo(dir);
  writeFileSync(join(dir, 'README.md'), 'readme\n');
  git('add', '.');
  git('commit', '-m', 'init');
  const big = join(dir, 'checkpoint.pt');
  writeLargeBinary(big); // untracked, above every snapshot bound
  const sessionId = 'git-large-delete';
  await beginTurnSnapshot(dir, sessionId, { checkpointId: 'prompt-1' });
  const result = await patch('*** Begin Patch\n*** Delete File: checkpoint.pt\n*** End Patch\n', dir, dir, {
    sessionId,
    toolCallId: 'delete-big',
  });
  assert.doesNotMatch(result, /^Error/);
  assert.equal(existsSync(big), false);

  const review = await getTurnReviewDiff(dir, sessionId);
  assert.equal(review.revertMode, 'worktree');
  const row = review.files.find((file) => file.path === 'checkpoint.pt');
  assert.ok(row, 'the deleted file is listed in the review');
  assert.equal(row.status, 'D');
  assert.equal(row.omitted, true);
  assert.equal(row.size, BIG_BYTES);
  assert.match(review.patch, /binary\/large file deleted \(12582912 bytes; content not captured\)/);
  await assert.rejects(
    revertTurnReviewFile(dir, sessionId, 'checkpoint.pt'),
    /content was not captured \(12582912 bytes\)/
  );
  await assert.rejects(revertTurnReview(dir, sessionId), /content was not captured/);
  assert.equal(existsSync(big), false);
});

for (const cwdKind of ['non-Git', 'Git']) {
  test(`a refused oversized update in a ${cwdKind} cwd stays out of the review and does not block undo`, async (t) => {
    const dir = makeDir(t);
    t.after(() => _resetTurnSnapshotForTest());
    const sessionId = `refused-oversized-${cwdKind}`;
    const big = join(dir, 'big.txt');
    const small = join(dir, 'notes.txt');
    writeFileSync(big, 'line\n'.repeat((9 * 1024 * 1024) / 5));
    writeFileSync(small, 'old\n');
    if (cwdKind === 'Git') {
      const git = initGitRepo(dir);
      git('config', 'core.autocrlf', 'false'); // revert checks out exact bytes
      writeFileSync(join(dir, 'README.md'), 'readme\n');
      git('add', 'README.md');
      git('commit', '-m', 'init');
      await beginTurnSnapshot(dir, sessionId, { checkpointId: 'prompt-1' });
    }
    const bigStat = statSync(big);
    const result = await patch(
      '*** Begin Patch\n*** Update File: big.txt\n@@\n-line\n+LINE\n*** Update File: notes.txt\n@@\n-old\n+new\n*** End Patch\n',
      dir,
      dir,
      { sessionId, toolCallId: 'mixed' }
    );
    assert.match(result, /larger than 8 MiB/);
    assert.equal(readFileSync(small, 'utf8'), 'new\n');
    assert.equal(statSync(big).mtimeMs, bigStat.mtimeMs);

    const review = await getTurnReviewDiff(dir, sessionId);
    assert.doesNotMatch(review.patch, /big\.txt/);
    assert.equal(
      review.files.some((file) => file.path === 'big.txt'),
      false
    );
    assert.match(review.patch, /notes\.txt/);
    await revertTurnReview(dir, sessionId);
    assert.equal(readFileSync(small, 'utf8'), 'old\n');
    assert.equal(statSync(big).size, bigStat.size);
  });
}

test('undo never deletes a deleted large file that reappeared with its old identity', async (t) => {
  const dir = makeDir(t);
  t.after(() => _resetTurnSnapshotForTest());
  const git = initGitRepo(dir);
  writeFileSync(join(dir, 'README.md'), 'readme\n');
  git('add', 'README.md');
  git('commit', '-m', 'init');
  const big = join(dir, 'checkpoint.pt');
  const keep = join(dir, 'kept-link.pt');
  writeLargeBinary(big);
  writeFileSync(join(dir, '.gitignore'), 'kept-link.pt\n');
  linkSync(big, keep); // the same inode survives the delete
  const expected = sha256(big);
  const sessionId = 'hardlink-reappear';
  await beginTurnSnapshot(dir, sessionId, { checkpointId: 'prompt-1' });
  const result = await patch('*** Begin Patch\n*** Delete File: checkpoint.pt\n*** End Patch\n', dir, dir, {
    sessionId,
    toolCallId: 'delete-big',
  });
  assert.doesNotMatch(result, /^Error/);
  linkSync(keep, big); // back with its old inode, size and mtime

  await assert.rejects(revertTurnReviewFile(dir, sessionId, 'checkpoint.pt'), /content was not captured/);
  await assert.rejects(revertTurnReview(dir, sessionId), /content was not captured/);
  assert.equal(sha256(big), expected);
});

test('an in-place change of an uncaptured file with its timestamp preserved is still reviewed', async (t) => {
  const dir = makeDir(t);
  t.after(() => _resetTurnSnapshotForTest());
  const big = join(dir, 'weights.bin');
  writeLargeBinary(big);
  const stamp = 1_700_000_000; // whole seconds: restorable exactly on every filesystem
  utimesSync(big, stamp, stamp);
  const before = capturePatchRollbackState([big]);
  assert.equal(before[0].omitted, true);
  const fd = openSync(big, 'r+');
  try {
    writeSync(fd, Buffer.from([0xab]), 0, 1, 1024 * 1024);
  } finally {
    closeSync(fd);
  }
  utimesSync(big, stamp, stamp);
  assert.equal(statSync(big).mtimeMs, before[0].mtimeMs);
  const sessionId = 'in-place-binary';
  registerCommittedPatchUiDiff({
    callId: 'in-place',
    sessionId,
    basePath: dir,
    beforeSnapshots: before,
    paths: [big],
  });
  const review = await getTurnReviewDiff(dir, sessionId);
  assert.match(review.patch, /binary\/large file changed \(12582912 bytes; content not captured\)/);
});

test('the turn review shows a deleted large file as omitted and refuses its tracked revert', async (t) => {
  const dir = makeDir(t);
  t.after(() => _resetTurnSnapshotForTest());
  const big = join(dir, 'best.pt');
  const small = join(dir, 'notes.txt');
  writeLargeBinary(big);
  writeFileSync(small, 'old\n');
  const sessionId = 'large-delete-review';
  const first = await patch('*** Begin Patch\n*** Delete File: best.pt\n*** End Patch\n', dir, dir, {
    sessionId,
    toolCallId: 'delete-big',
  });
  assert.doesNotMatch(first, /^Error/);
  const second = await patch('*** Begin Patch\n*** Update File: notes.txt\n@@\n-old\n+new\n*** End Patch\n', dir, dir, {
    sessionId,
    toolCallId: 'edit-small',
  });
  assert.doesNotMatch(second, /^Error/);
  assert.equal(existsSync(big), false);

  const review = await getTurnReviewDiff(dir, sessionId);
  assert.match(
    review.patch,
    /deleted file mode 100644\nbinary\/large file deleted \(12582912 bytes; content not captured\)/
  );
  assert.match(review.patch, /-old\n\+new/);
  await assert.rejects(revertTurnReviewFile(dir, sessionId, 'best.pt'), /content was not captured \(12582912 bytes\)/);
  assert.equal(existsSync(big), false);
  // The text file of the same turn stays revertable.
  await revertTurnReviewFile(dir, sessionId, 'notes.txt');
  assert.equal(readFileSync(small, 'utf8'), 'old\n');
});
