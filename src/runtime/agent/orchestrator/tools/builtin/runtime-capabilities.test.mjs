import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import childProcess, { spawnSync } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import test from 'node:test';

import {
  describeCwdStartupEntries,
  describeGitStartupState,
  describeShellToolsStartupState,
  prewarmGitStartupProbes,
  settleGitStartupProbes,
} from './runtime-capabilities.mjs';

test('Shell tools startup line reads a POSIX login shell and renders present/absent names', () => {
  const calls = [];
  const line = describeShellToolsStartupState({
    platform: 'linux',
    shellPath: '/bin/bash',
    names: ['python3', 'python', 'file', 'node'],
    _spawnSync: (shell, args, options) => {
      calls.push({ shell, args, options });
      return { status: 1, stdout: '/usr/bin/python3\n/usr/local/bin/node\n', stderr: '' };
    },
  });
  assert.equal(line, '- Shell tools at startup: python3 node; absent: python file.');
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args, ['-lc', 'command -v python3 python file node']);
  assert.ok(calls[0].options.timeout > 0, 'probe is time-bounded');
});

test('Shell tools startup line renders nothing when the probe fails or times out', () => {
  const timedOut = describeShellToolsStartupState({
    platform: 'linux',
    shellPath: '/bin/bash',
    _spawnSync: () => ({
      status: null,
      stdout: '',
      error: Object.assign(new Error('ETIMEDOUT'), { code: 'ETIMEDOUT' }),
    }),
  });
  assert.equal(timedOut, '');
  const threw = describeShellToolsStartupState({
    platform: 'linux',
    shellPath: '/bin/bash',
    _spawnSync: () => {
      throw new Error('spawn failed');
    },
  });
  assert.equal(threw, '');
});

test('Shell tools startup line on Windows walks PATH and ignores the Store stub', {
  skip: process.platform === 'win32' ? false : 'PATH delimiter is platform-bound',
}, () => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-shell-tools-win-'));
  try {
    const real = join(root, 'real');
    const store = join(root, 'WindowsApps');
    mkdirSync(real);
    mkdirSync(store);
    writeFileSync(join(real, 'node.exe'), '');
    writeFileSync(join(store, 'python.exe'), '');
    const line = describeShellToolsStartupState({
      platform: 'win32',
      names: ['python', 'node', 'jq'],
      pathValue: `${real};${store}`,
    });
    assert.equal(line, '- Shell tools at startup: node; absent: python jq.');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

const gitAvailable =
  spawnSync('git', ['--version'], {
    encoding: 'utf8',
    windowsHide: true,
  }).status === 0;

// Counts git processes started on this (the event loop) thread; the git
// worker thread has its own child_process module and is not counted.
function countMainThreadSpawns(t) {
  const calls = [];
  for (const name of ['spawn', 'spawnSync', 'execFile', 'execFileSync']) {
    const original = childProcess[name];
    t.mock.method(childProcess, name, (command, ...args) => {
      calls.push(`${name} ${command}`);
      return original(command, ...args);
    });
  }
  syncBuiltinESMExports();
  return {
    calls,
    restore() {
      t.mock.restoreAll();
      syncBuiltinESMExports();
    },
  };
}

test('Git startup state probes synchronously on first use, then serves cached state refreshed off-thread', {
  skip: gitAvailable ? false : 'git is unavailable',
}, async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-git-startup-'));
  try {
    assert.equal(
      spawnSync('git', ['init', '-q'], {
        cwd: root,
        encoding: 'utf8',
        windowsHide: true,
      }).status,
      0
    );
    const describe = () => describeGitStartupState({ cwd: root, capabilities: { available: ['git'] } });

    // First use in this process: the exact synchronous probe.
    const clean = describe();
    assert.match(clean, /Git startup state: repository root /);
    assert.match(clean, /; clean\.$/);

    writeFileSync(join(root, 'dirty.txt'), 'dirty\n');
    const spawns = countMainThreadSpawns(t);
    try {
      // Later uses serve the cached answer and refresh it off the event loop.
      assert.match(describe(), /; clean\.$/);
      await settleGitStartupProbes();
      assert.match(describe(), /; changes present\.$/);
      await settleGitStartupProbes();
    } finally {
      spawns.restore();
    }
    assert.deepEqual(spawns.calls, [], 'later uses spawned git on the event loop thread');
  } finally {
    await settleGitStartupProbes();
    rmSync(root, { recursive: true, force: true });
  }
});

function prewarmFixture() {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-git-prewarm-'));
  assert.equal(spawnSync('git', ['init', '-q'], { cwd: root, encoding: 'utf8', windowsHide: true }).status, 0);
  writeFileSync(join(root, '.gitignore'), 'build/\n');
  mkdirSync(join(root, 'build'));
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'dirty.txt'), 'dirty\n');
  return root;
}
const expectedCwdLine = '- Cwd entries at startup: src/ .gitignore dirty.txt';

test('a finished prewarm lets the first session compose without spawning git on the event loop', {
  skip: gitAvailable ? false : 'git is unavailable',
}, async (t) => {
  const root = prewarmFixture();
  try {
    prewarmGitStartupProbes([root]);
    await settleGitStartupProbes();
    const spawns = countMainThreadSpawns(t);
    let gitLine;
    let cwdLine;
    try {
      gitLine = describeGitStartupState({ cwd: root, capabilities: { available: ['git'] } });
      cwdLine = describeCwdStartupEntries({ cwd: root });
      await settleGitStartupProbes();
    } finally {
      spawns.restore();
    }
    assert.deepEqual(spawns.calls, [], 'the first session spawned git on the event loop thread');
    assert.match(gitLine, /; changes present\.$/);
    assert.equal(cwdLine, expectedCwdLine);
  } finally {
    await settleGitStartupProbes();
    rmSync(root, { recursive: true, force: true });
  }
});

test('an unfinished prewarm falls back to the synchronous probe with identical output', {
  skip: gitAvailable ? false : 'git is unavailable',
}, async (t) => {
  const root = prewarmFixture();
  try {
    prewarmGitStartupProbes([root]);
    // Composed before the prewarm answered.
    const spawns = countMainThreadSpawns(t);
    let gitLine;
    let cwdLine;
    try {
      gitLine = describeGitStartupState({ cwd: root, capabilities: { available: ['git'] } });
      cwdLine = describeCwdStartupEntries({ cwd: root });
    } finally {
      spawns.restore();
    }
    assert.equal(spawns.calls.filter((call) => call === 'spawnSync git').length, 2);
    assert.match(gitLine, /; changes present\.$/);
    assert.equal(cwdLine, expectedCwdLine);
    // The late prewarm answers never replace the newer synchronous ones.
    await settleGitStartupProbes();
    assert.equal(describeGitStartupState({ cwd: root, capabilities: { available: ['git'] } }), gitLine);
    assert.equal(describeCwdStartupEntries({ cwd: root }), expectedCwdLine);
  } finally {
    await settleGitStartupProbes();
    rmSync(root, { recursive: true, force: true });
  }
});

test('Git startup state preserves the non-repository message', () => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-nonrepo-startup-'));
  try {
    const state = describeGitStartupState({
      cwd: root,
      capabilities: { available: ['git'] },
    });
    assert.match(state, /was not inside a git repository at startup/);
    assert.doesNotMatch(state, /; (?:clean|changes present)\./);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Cwd startup entries list directories first, then files, with a cap', () => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-cwd-entries-'));
  try {
    assert.equal(describeCwdStartupEntries({ cwd: root }), '- Cwd entries at startup: none (empty directory).');

    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, 'README.md'), 'x\n');
    writeFileSync(join(root, 'app.py'), 'x\n');
    assert.equal(describeCwdStartupEntries({ cwd: root }), '- Cwd entries at startup: src/ app.py README.md');

    for (let index = 0; index < 5; index += 1) writeFileSync(join(root, `z${index}.txt`), '');
    mkdirSync(join(root, 'zz-last-dir'));
    const capped = describeCwdStartupEntries({ cwd: root, limit: 4 });
    assert.match(
      capped,
      /^- Cwd entries at startup: src\/ zz-last-dir\/ app\.py README\.md … \+5 more \(list for the rest\)$/
    );

    assert.equal(describeCwdStartupEntries({ cwd: join(root, 'missing') }), '');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Cwd startup entries drop .git and gitignored entries inside a repository', {
  skip: gitAvailable ? false : 'git is unavailable',
}, async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-cwd-entries-git-'));
  try {
    assert.equal(spawnSync('git', ['init', '-q'], { cwd: root, encoding: 'utf8', windowsHide: true }).status, 0);
    writeFileSync(join(root, '.gitignore'), 'build/\n*.log\n.tmp-*\n');
    mkdirSync(join(root, 'build'));
    mkdirSync(join(root, '.tmp-scratch'));
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, 'debug.log'), '');
    writeFileSync(join(root, 'package.json'), '{}\n');
    const expected = '- Cwd entries at startup: src/ .gitignore package.json';
    // First use in this process: the exact synchronous `git check-ignore`.
    assert.equal(describeCwdStartupEntries({ cwd: root }), expected);

    const spawns = countMainThreadSpawns(t);
    try {
      // Same entries: cached answer, refreshed off the event loop.
      assert.equal(describeCwdStartupEntries({ cwd: root }), expected);
      await settleGitStartupProbes();
      assert.equal(describeCwdStartupEntries({ cwd: root }), expected);
      await settleGitStartupProbes();
    } finally {
      spawns.restore();
    }
    assert.deepEqual(spawns.calls, [], 'later uses spawned git on the event loop thread');

    rmSync(join(root, 'src'), { recursive: true, force: true });
    rmSync(join(root, 'package.json'), { force: true });
    rmSync(join(root, '.gitignore'), { force: true });
    writeFileSync(join(root, '.git', 'info', 'exclude'), '*\n');
    // Changed entries: the cached answer does not cover them, so the
    // synchronous probe answers right away instead of omitting the line.
    assert.equal(
      describeCwdStartupEntries({ cwd: root }),
      '- Cwd entries at startup: none besides gitignored entries.'
    );
  } finally {
    await settleGitStartupProbes();
    rmSync(root, { recursive: true, force: true });
  }
});
