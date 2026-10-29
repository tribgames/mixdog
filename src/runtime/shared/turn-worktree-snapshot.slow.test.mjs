import assert from 'node:assert/strict';
import childProcess, { spawnSync } from 'node:child_process';
import fs, { mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import test from 'node:test';

const gitAvailable = spawnSync('git', ['--version'], { encoding: 'utf8', windowsHide: true }).status === 0;

// The shadow repositories live under MIXDOG_DATA_DIR, resolved at import.
const root = mkdtempSync(join(tmpdir(), 'mixdog-turn-worktree-'));
process.env.MIXDOG_DATA_DIR = join(root, 'data');
process.on('exit', () => {
  rmSync(root, { recursive: true, force: true });
});

const {
  _resetTurnWorktreeSnapshotsForTest,
  createTurnWorktreeSnapshot,
  noteTurnWorktreeChange,
  recordTurnWorktreeFileChange,
  refreshTurnWorktreeSnapshot,
  resumeTurnWorktreeFilePatch,
} = await import('./turn-worktree-snapshot.mjs');

function git(cwd, ...args) {
  const result = spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
  });
  assert.equal(result.status, 0, result.stderr);
}

test('turn worktree snapshots spawn git off the event loop and keep their contents', {
  skip: gitAvailable ? false : 'git is unavailable',
}, async (t) => {
  const repo = join(root, 'repo');
  mkdirSync(repo, { recursive: true });
  git(repo, 'init', '-q');
  // Exact LF bytes regardless of the machine's global line-ending config.
  git(repo, 'config', 'core.autocrlf', 'false');
  writeFileSync(join(repo, 'a.txt'), 'original a\n');
  writeFileSync(join(repo, 'b.txt'), 'original b\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-qm', 'seed');

  const mainThreadSpawns = [];
  const spawn = childProcess.spawn;
  t.mock.method(childProcess, 'spawn', (command, ...args) => {
    mainThreadSpawns.push(command);
    return spawn(command, ...args);
  });
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });

  const snapshot = await createTurnWorktreeSnapshot(repo);
  assert.match(snapshot.baselineTree, /^[0-9a-f]{40,64}$/);
  writeFileSync(join(repo, 'a.txt'), 'changed a\n');
  rmSync(join(repo, 'b.txt'));
  writeFileSync(join(repo, 'new.txt'), 'new file\n');
  noteTurnWorktreeChange([join(repo, 'a.txt'), join(repo, 'b.txt'), join(repo, 'new.txt')]);
  await refreshTurnWorktreeSnapshot(snapshot);

  assert.deepEqual(
    snapshot.files.map(({ path, status, additions, deletions }) => ({ path, status, additions, deletions })),
    [
      { path: 'a.txt', status: 'M', additions: 1, deletions: 1 },
      { path: 'b.txt', status: 'D', additions: 0, deletions: 1 },
      { path: 'new.txt', status: 'A', additions: 1, deletions: 0 },
    ]
  );
  assert.match(snapshot.patch, /^\+changed a$/m);
  assert.equal(snapshot.patchTruncated, false);

  assert.deepEqual(mainThreadSpawns, [], 'git was spawned on the event loop thread');
});

test('an autocrlf checkout touched without edits is not a diff', {
  skip: gitAvailable ? false : 'git is unavailable',
}, async () => {
  const repo = join(root, 'crlf-repo');
  mkdirSync(repo, { recursive: true });
  git(repo, 'init', '-q');
  git(repo, 'config', 'core.autocrlf', 'true');
  writeFileSync(join(repo, 'a.txt'), 'one\r\ntwo\r\nthree\r\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-qm', 'seed');

  const snapshot = await createTurnWorktreeSnapshot(repo);
  // Same CRLF bytes, new mtime: the shadow index sees a stat-dirty entry.
  writeFileSync(join(repo, 'a.txt'), 'one\r\ntwo\r\nthree\r\n');
  const later = new Date(Date.now() + 60_000);
  utimesSync(join(repo, 'a.txt'), later, later);
  noteTurnWorktreeChange([join(repo, 'a.txt')]);
  await refreshTurnWorktreeSnapshot(snapshot);
  assert.deepEqual(snapshot.files, []);

  writeFileSync(join(repo, 'a.txt'), 'one\r\nTWO\r\nthree\r\n');
  noteTurnWorktreeChange([join(repo, 'a.txt')]);
  await refreshTurnWorktreeSnapshot(snapshot);
  assert.deepEqual(
    snapshot.files.map(({ path, additions, deletions }) => ({ path, additions, deletions })),
    [{ path: 'a.txt', additions: 1, deletions: 1 }]
  );
});

function seedRepo(name) {
  const repo = join(root, name);
  mkdirSync(repo, { recursive: true });
  git(repo, 'init', '-q');
  git(repo, 'config', 'core.autocrlf', 'false');
  writeFileSync(join(repo, 'a.txt'), 'original a\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-qm', 'seed');
  return repo;
}

test('overlapping review polls share one capture', {
  skip: gitAvailable ? false : 'git is unavailable',
}, async () => {
  const repo = seedRepo('overlap-repo');
  const snapshot = await createTurnWorktreeSnapshot(repo);
  writeFileSync(join(repo, 'a.txt'), 'changed a\n');
  noteTurnWorktreeChange([join(repo, 'a.txt')]);
  const before = snapshot.refreshSeq;
  const results = await Promise.all([
    refreshTurnWorktreeSnapshot(snapshot),
    refreshTurnWorktreeSnapshot(snapshot),
    refreshTurnWorktreeSnapshot(snapshot),
  ]);
  assert.equal(snapshot.refreshSeq - before, 1, 'one capture answers every overlapping poll');
  assert.ok(results.every((value) => value === snapshot));
  assert.deepEqual(
    snapshot.files.map(({ path }) => path),
    ['a.txt']
  );
  // Nothing reported since: a poll right after reuses that capture.
  await refreshTurnWorktreeSnapshot(snapshot);
  assert.equal(snapshot.refreshSeq - before, 1);
});

test('an edit after the last capture shows on the next poll', {
  skip: gitAvailable ? false : 'git is unavailable',
}, async () => {
  const repo = seedRepo('next-poll-repo');
  const snapshot = await createTurnWorktreeSnapshot(repo);
  writeFileSync(join(repo, 'a.txt'), 'first edit\n');
  noteTurnWorktreeChange([join(repo, 'a.txt')]);
  await refreshTurnWorktreeSnapshot(snapshot);
  assert.match(snapshot.patch, /^\+first edit$/m);

  // A tool write reports its path; the very next poll captures it.
  writeFileSync(join(repo, 'b.txt'), 'new b\n');
  noteTurnWorktreeChange([join(repo, 'b.txt')]);
  await refreshTurnWorktreeSnapshot(snapshot);
  assert.deepEqual(
    snapshot.files.map(({ path, status }) => ({ path, status })),
    [
      { path: 'a.txt', status: 'M' },
      { path: 'b.txt', status: 'A' },
    ]
  );

  // A write under another root is not a signal for this one.
  const before = snapshot.refreshSeq;
  noteTurnWorktreeChange([join(root, 'elsewhere', 'x.txt')]);
  await refreshTurnWorktreeSnapshot(snapshot);
  assert.equal(snapshot.refreshSeq, before);

  // An unreported write is still captured by a forced refresh.
  writeFileSync(join(repo, 'a.txt'), 'second edit\n');
  await refreshTurnWorktreeSnapshot(snapshot, { force: true });
  assert.match(snapshot.patch, /^\+second edit$/m);
});

test('an unreported write waits for the recapture gap, a reported one does not', {
  skip: gitAvailable ? false : 'git is unavailable',
}, async (t) => {
  const repo = seedRepo('gap-repo');
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  t.after(() => t.mock.timers.reset());
  const snapshot = await createTurnWorktreeSnapshot(repo);

  // Unreported, well inside the gap (a 6 s timer poll): the capture stands.
  writeFileSync(join(repo, 'a.txt'), 'unreported edit\n');
  t.mock.timers.tick(6_000);
  await refreshTurnWorktreeSnapshot(snapshot);
  assert.deepEqual(snapshot.files, []);

  // Past the 15 s gap the next poll captures it.
  t.mock.timers.tick(9_000);
  await refreshTurnWorktreeSnapshot(snapshot);
  assert.match(snapshot.patch, /^\+unreported edit$/m);

  // Reported writes capture at once, at any point in the gap.
  writeFileSync(join(repo, 'b.txt'), 'reported b\n');
  noteTurnWorktreeChange([join(repo, 'b.txt')]);
  await refreshTurnWorktreeSnapshot(snapshot);
  assert.deepEqual(
    snapshot.files.map(({ path }) => path),
    ['a.txt', 'b.txt']
  );

  // So does a change of the repository's own index (a commit or staging).
  writeFileSync(join(repo, 'c.txt'), 'staged c\n');
  git(repo, 'add', 'c.txt');
  await refreshTurnWorktreeSnapshot(snapshot);
  assert.ok(snapshot.files.some(({ path }) => path === 'c.txt'));
});

const lineCount = (text, pattern) => text.match(pattern)?.length ?? 0;

test('a too-large file is listed with its counts while the other files keep their patches', {
  skip: gitAvailable ? false : 'git is unavailable',
}, async () => {
  const repo = seedRepo('large-file-repo');
  writeFileSync(join(repo, 'big.txt'), 'seed\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-qm', 'big');
  const snapshot = await createTurnWorktreeSnapshot(repo);
  // 1.2 MB of added lines: past the 1 MB per-file cap, within the total.
  writeFileSync(join(repo, 'big.txt'), `${'x'.repeat(9)}\n`.repeat(120_000));
  writeFileSync(join(repo, 'a.txt'), 'changed a\n');
  writeFileSync(join(repo, 'c.txt'), 'new c\n');
  noteTurnWorktreeChange(null);
  await refreshTurnWorktreeSnapshot(snapshot, { force: true });
  const byPath = Object.fromEntries(snapshot.files.map((file) => [file.path, file]));
  assert.deepEqual(Object.keys(byPath), ['a.txt', 'big.txt', 'c.txt']);
  assert.deepEqual(
    [
      byPath['big.txt'].additions,
      byPath['big.txt'].deletions,
      byPath['big.txt'].patchOmitted,
      byPath['big.txt'].reason,
    ],
    [120_000, 1, true, 'too_large']
  );
  assert.equal(byPath['a.txt'].patchOmitted, undefined);
  assert.equal(byPath['c.txt'].patchOmitted, undefined);
  assert.match(snapshot.patch, /^\+changed a$/m);
  assert.match(snapshot.patch, /^\+new c$/m);
  assert.doesNotMatch(snapshot.patch, /big\.txt/);
  assert.equal(snapshot.diffTooLarge, false);

  // Opened on its own, the file reads whole within the larger cap.
  const scope = { paths: ['a.txt', 'big.txt', 'c.txt'], path: 'big.txt' };
  const whole = await resumeTurnWorktreeFilePatch(repo, snapshot.baselineTree, { ...scope, maxBytes: 8 * 1024 * 1024 });
  assert.match(whole.patch, /^diff --git a\/big\.txt b\/big\.txt$/m);
  assert.equal(lineCount(whole.patch, /^\+x{9}$/gm), 120_000);
  assert.deepEqual(await resumeTurnWorktreeFilePatch(repo, snapshot.baselineTree, { ...scope, maxBytes: 64 * 1024 }), {
    patch: '',
    patchOmitted: true,
    reason: 'too_large',
  });
  // A file outside the recording session's scope is never read.
  assert.deepEqual(
    await resumeTurnWorktreeFilePatch(repo, snapshot.baselineTree, {
      paths: ['a.txt'],
      path: 'big.txt',
      maxBytes: 1e7,
    }),
    { patch: '' }
  );
  // Every target is authorized on its own: an owned rename source never
  // opens an unowned file, an unowned one never joins an owned file's diff.
  assert.deepEqual(
    await resumeTurnWorktreeFilePatch(repo, snapshot.baselineTree, {
      paths: ['a.txt'],
      path: 'big.txt',
      oldPath: 'a.txt',
      maxBytes: 1e7,
    }),
    { patch: '' }
  );
  const own = await resumeTurnWorktreeFilePatch(repo, snapshot.baselineTree, {
    paths: ['a.txt'],
    path: 'a.txt',
    oldPath: 'big.txt',
    maxBytes: 1e7,
  });
  assert.match(own.patch, /^\+changed a$/m);
  assert.doesNotMatch(own.patch, /big\.txt|x{9}/);

  // Nothing but the large file changed: no patch fits at all.
  writeFileSync(join(repo, 'a.txt'), 'original a\n');
  rmSync(join(repo, 'c.txt'));
  await refreshTurnWorktreeSnapshot(snapshot, { force: true });
  assert.deepEqual(
    snapshot.files.map(({ path, patchOmitted }) => [path, patchOmitted]),
    [['big.txt', true]]
  );
  assert.equal(snapshot.patch, '');
  assert.equal(snapshot.diffTooLarge, true);
});

test('a range whose whole patch passes the read limit still carries the small files', {
  skip: gitAvailable ? false : 'git is unavailable',
}, async () => {
  const repo = seedRepo('huge-range-repo');
  writeFileSync(join(repo, 'big.txt'), 'seed\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-qm', 'big');
  const snapshot = await createTurnWorktreeSnapshot(repo);
  // ~9.2 MB: the whole-range read overflows; batches are halved around it.
  writeFileSync(join(repo, 'big.txt'), `${'y'.repeat(99)}\n`.repeat(92_000));
  writeFileSync(join(repo, 'a.txt'), 'changed a\n');
  writeFileSync(join(repo, 'c.txt'), 'new c\n');
  noteTurnWorktreeChange(null);
  await refreshTurnWorktreeSnapshot(snapshot, { force: true });
  assert.deepEqual(
    snapshot.files.map(({ path, additions, patchOmitted }) => [path, additions, patchOmitted]),
    [
      ['a.txt', 1, undefined],
      ['big.txt', 92_000, true],
      ['c.txt', 1, undefined],
    ]
  );
  assert.match(snapshot.patch, /^\+changed a$/m);
  assert.match(snapshot.patch, /^\+new c$/m);
  assert.equal(snapshot.diffTooLarge, false);
});

test('a directory outside any repository yields no snapshot', {
  skip: gitAvailable ? false : 'git is unavailable',
}, async () => {
  const plain = join(root, 'plain');
  mkdirSync(plain, { recursive: true });
  assert.equal(await createTurnWorktreeSnapshot(plain), null);
});

test('tool first states fill the baseline without disturbing the shadow index', {
  skip: gitAvailable ? false : 'git is unavailable',
}, async () => {
  const repo = seedRepo('tool-baseline-repo');
  writeFileSync(join(repo, '.gitignore'), 'dist/\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-qm', 'ignore dist');
  mkdirSync(join(repo, 'dist'));
  writeFileSync(join(repo, 'dist', 'out.js'), 'before\n');
  const snapshot = await createTurnWorktreeSnapshot(repo);
  const original = snapshot.baselineTree;
  // An ignored file the baseline never saw, a tracked edit and a new file, each
  // reported with its first state by the tool that wrote it.
  const edit = (path, after) => {
    const full = join(repo, path);
    recordTurnWorktreeFileChange(snapshot, full, fs.existsSync(full) ? fs.readFileSync(full) : null);
    writeFileSync(full, after);
  };
  edit('dist/out.js', 'after\n');
  edit('a.txt', 'changed a\n');
  edit('new.txt', 'new\n');
  noteTurnWorktreeChange(null);
  await refreshTurnWorktreeSnapshot(snapshot, { force: true });
  const shape = (files) => files.map(({ path, status, additions, deletions }) => [path, status, additions, deletions]);
  assert.deepEqual(shape(snapshot.files), [
    ['a.txt', 'M', 1, 1],
    ['dist/out.js', 'M', 1, 1],
    ['new.txt', 'A', 1, 0],
  ]);
  assert.match(snapshot.patch, /^-before\n\+after$/m);
  const recorded = [...snapshot.baselineFiles.values()].sort((left, right) => left.path.localeCompare(right.path));
  assert.deepEqual(
    recorded.map(({ path, oid }) => [path, /^[0-9a-f]{40,64}$/.test(oid || '') ? 'blob' : oid]),
    [
      ['dist/out.js', 'blob'],
      ['new.txt', null],
    ]
  );
  // Resumed from the unfilled baseline plus the recorded first states.
  for (const [path, pattern] of [
    ['dist/out.js', /^-before\n\+after$/m],
    ['new.txt', /^new file mode 100644$[\s\S]*^\+new$/m],
  ]) {
    const reply = await resumeTurnWorktreeFilePatch(repo, original, {
      baselineFiles: recorded,
      path,
      maxBytes: 64 * 1024,
    });
    assert.match(reply.patch, pattern);
  }
  // The baseline was built in an index of its own, removed afterwards; the
  // shadow index still answers an unchanged worktree with no change.
  assert.deepEqual(
    fs.readdirSync(snapshot.state.gitDir).filter((name) => name.startsWith('index.baseline')),
    []
  );
  await refreshTurnWorktreeSnapshot(snapshot, { force: true });
  assert.deepEqual(shape(snapshot.files), [
    ['a.txt', 'M', 1, 1],
    ['dist/out.js', 'M', 1, 1],
    ['new.txt', 'A', 1, 0],
  ]);
});

// HEAD's canonicalPath, kept as the oracle for which states a note must dirty.
function referenceCanonical(value) {
  const full = resolve(value);
  let head = full;
  while (!fs.existsSync(head)) {
    const parent = dirname(head);
    if (parent === head) return full;
    head = parent;
  }
  return join(fs.realpathSync(head), relative(head, full));
}

function referenceKey(value) {
  const text = referenceCanonical(value).replace(/\\/g, '/');
  return process.platform === 'win32' ? text.toLowerCase() : text;
}

function referenceHits(snapshot, paths) {
  const keys = paths.map(referenceKey);
  const rootKey = referenceKey(snapshot.root);
  return keys.length === 0 || keys.some((key) => key === rootKey || key.startsWith(`${rootKey}/`));
}

test('a change burst with no tracked state performs no filesystem calls', (t) => {
  _resetTurnWorktreeSnapshotsForTest();
  const calls = [];
  for (const name of ['existsSync', 'lstatSync', 'realpathSync', 'statSync']) {
    const original = fs[name];
    t.mock.method(fs, name, (...args) => {
      calls.push(name);
      return original(...args);
    });
  }
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  noteTurnWorktreeChange([join(root, 'x', 'a.txt'), join(root, 'y')]);
  noteTurnWorktreeChange(null);
  assert.deepEqual(calls, []);
});

test('a note dirties exactly the states HEAD canonicalization would', {
  skip: gitAvailable ? false : 'git is unavailable',
}, async () => {
  const repoA = seedRepo('equiv-a');
  const repoB = seedRepo('equiv-b');
  const other = join(root, 'equiv-other');
  mkdirSync(join(other, 'dir'), { recursive: true });
  writeFileSync(join(other, 'dir', 'x.txt'), 'x');
  mkdirSync(join(repoA, 'sub'), { recursive: true });
  writeFileSync(join(repoA, 'sub', 'f.txt'), 'f');
  const linkA = join(root, 'equiv-link-a');
  symlinkSync(repoA, linkA, 'junction');
  const linkOut = join(root, 'equiv-link-out');
  symlinkSync(other, linkOut, 'junction');
  const fileLink = join(repoB, 'to-a');
  let fileLinked = true;
  try {
    symlinkSync(join(repoA, 'a.txt'), fileLink, 'file');
  } catch {
    fileLinked = false; // creating file symlinks needs a privilege on Windows
  }
  const snapshots = [await createTurnWorktreeSnapshot(repoA), await createTurnWorktreeSnapshot(repoB)];
  const many = Array.from({ length: 30 }, (_, i) => join(repoB, 'sub', `m${i}.txt`));
  const cases = {
    'path in root': [join(repoA, 'sub', 'f.txt')],
    'junction into root': [join(linkA, 'a.txt')],
    'deleted file': [join(repoB, 'gone.txt')],
    'deleted path under junction': [join(linkA, 'no', 'such.txt')],
    'unrelated existing path': [join(other, 'dir', 'x.txt')],
    'unrelated missing path': [join(other, 'dir', 'missing', 'y.txt')],
    'junction out of roots': [join(linkOut, 'dir', 'x.txt')],
    'root itself': [repoA],
    'many files in one directory': many,
    'mixed burst': [join(other, 'dir', 'x.txt'), join(linkA, 'a.txt'), ...many],
    'empty list': [],
    null: null,
  };
  if (fileLinked) cases['file link into other root'] = [fileLink];
  if (process.platform === 'win32') cases['differing case'] = [join(repoA, 'SUB', 'F.TXT'), join(repoB, 'A.TXT')];
  for (const [name, paths] of Object.entries(cases)) {
    const expected = snapshots.map((snapshot) => referenceHits(snapshot, paths ?? []));
    const before = snapshots.map((snapshot) => snapshot.state.changeStamp);
    noteTurnWorktreeChange(paths);
    const actual = snapshots.map((snapshot, i) => snapshot.state.changeStamp !== before[i]);
    assert.deepEqual(actual, expected, name);
  }
});

test('a 200-file burst in 5 directories canonicalizes each directory once', {
  skip: gitAvailable ? false : 'git is unavailable',
}, async (t) => {
  const repo = seedRepo('burst-repo');
  const paths = [];
  for (let d = 0; d < 5; d += 1) {
    mkdirSync(join(repo, `d${d}`), { recursive: true });
    for (let i = 0; i < 40; i += 1) {
      const file = join(repo, `d${d}`, `f${i}.txt`);
      writeFileSync(file, 'x');
      paths.push(file);
    }
  }
  const snapshot = await createTurnWorktreeSnapshot(repo);
  const counts = { existsSync: 0, lstatSync: 0, realpathSync: 0 };
  for (const name of Object.keys(counts)) {
    const original = fs[name];
    t.mock.method(fs, name, (...args) => {
      counts[name] += 1;
      return original(...args);
    });
  }
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  const total = () => counts.existsSync + counts.lstatSync + counts.realpathSync;
  paths.forEach(referenceCanonical);
  const headCalls = total();
  counts.existsSync = counts.lstatSync = counts.realpathSync = 0;
  const before = snapshot.state.changeStamp;
  noteTurnWorktreeChange(paths);
  const newCalls = total();
  assert.equal(snapshot.state.changeStamp, before + 1);
  assert.ok(newCalls < headCalls * 0.6, `${newCalls} vs ${headCalls}`);
});
