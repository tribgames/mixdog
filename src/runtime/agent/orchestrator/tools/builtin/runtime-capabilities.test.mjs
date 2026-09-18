import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import {
  describeCwdStartupEntries,
  describeGitStartupState,
  describeShellToolsStartupState,
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

test('Git startup state reports clean and dirty repository snapshots', {
  skip: gitAvailable ? false : 'git is unavailable',
}, () => {
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

    const clean = describeGitStartupState({
      cwd: root,
      capabilities: { available: ['git'] },
    });
    assert.match(clean, /Git startup state: repository root /);
    assert.match(clean, /; clean\.$/);

    writeFileSync(join(root, 'dirty.txt'), 'dirty\n');
    const dirty = describeGitStartupState({
      cwd: root,
      capabilities: { available: ['git'] },
    });
    assert.match(dirty, /; changes present\.$/);
  } finally {
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
}, () => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-cwd-entries-git-'));
  try {
    assert.equal(
      spawnSync('git', ['init', '-q'], { cwd: root, encoding: 'utf8', windowsHide: true }).status,
      0
    );
    writeFileSync(join(root, '.gitignore'), 'build/\n*.log\n.tmp-*\n');
    mkdirSync(join(root, 'build'));
    mkdirSync(join(root, '.tmp-scratch'));
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, 'debug.log'), '');
    writeFileSync(join(root, 'package.json'), '{}\n');
    assert.equal(
      describeCwdStartupEntries({ cwd: root }),
      '- Cwd entries at startup: src/ .gitignore package.json'
    );

    rmSync(join(root, 'src'), { recursive: true, force: true });
    rmSync(join(root, 'package.json'), { force: true });
    rmSync(join(root, '.gitignore'), { force: true });
    writeFileSync(join(root, '.git', 'info', 'exclude'), '*\n');
    assert.equal(
      describeCwdStartupEntries({ cwd: root }),
      '- Cwd entries at startup: none besides gitignored entries.'
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
