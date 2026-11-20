import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { ALLOW, MACHINE_PATH, checkMachinePaths, scan } from './check-machine-paths.mjs';

// Assembled so this file stays clean under its own check.
const user = 'tem' + 'pe';
const driveD = 'D:';
const driveC = 'C:';
const samples = [
  `${driveD}\\mixdog-build\\tools\\x.ps1`,
  `${driveD}/mixdog-build/tmp/w1`,
  `${driveD}\\\\Project\\\\app`,
  `C:\\Users\\${user}\\.mixdog`,
  `C:/Users/${user}/AppData`,
  `${driveC}\\Project\\mixdog\\src`,
  `${driveC.toLowerCase()}/project/mixdog/`,
  `/Users/${user}/work`,
  `/home/${user}/work`,
];

test('every spelling of a developer-machine path is caught', () => {
  for (const sample of samples) assert.ok(MACHINE_PATH.test(sample), sample);
});

test('neutral paths and look-alike names pass', () => {
  for (const clean of ['C:\\Project\\sample', '<repo>/src', 'C:\\Users\\alice', `/home/${user}s/x`, 'D:\\Sandbox']) {
    assert.equal(MACHINE_PATH.test(clean), false, clean);
  }
});

test('scan reports file and line of each hit and skips allow-listed files', () => {
  const files = {
    'docs/a.md': `fine\nsee ${samples[0]}\r\nmore ${samples[5]}`,
    'src/b.mjs': 'const x = 1;',
    'benchmarks/terminal-bench-2.1/records/run/out.log': samples[0],
  };
  assert.deepEqual(
    scan(Object.keys(files), (file) => files[file]),
    [
      { file: 'docs/a.md', line: 2 },
      { file: 'docs/a.md', line: 3 },
    ]
  );
});

test('without an allow-list nothing is exempt', () => {
  assert.equal(scan(['benchmarks/terminal-bench-2.1/records/run/out.log'], () => samples[0], []).length, 1);
});

test('a binary file is scanned as bytes, not skipped', () => {
  const bytes = Buffer.concat([Buffer.from([0, 1, 2, 0]), Buffer.from(`x ${samples[3]} y`), Buffer.from([0, 255])]);
  assert.deepEqual(
    scan(['bin/tool.exe'], () => bytes),
    [{ file: 'bin/tool.exe', line: 1 }]
  );
});

test('a UTF-16 text is scanned too', () => {
  assert.equal(scan(['notes.txt'], () => Buffer.from(samples[5], 'utf16le')).length, 1);
});

test('a clean binary passes', () => {
  assert.deepEqual(
    scan(['bin/clean.bin'], () => Buffer.from([0, 1, 2, 3, 0, 255])),
    []
  );
});

test('a file that cannot be read is a failure, not a pass', () => {
  const hits = scan(['src/gone.mjs'], () => {
    throw new Error('EACCES: permission denied');
  });
  assert.equal(hits.length, 1);
  assert.match(hits[0].unreadable, /EACCES/);
});

test('checkMachinePaths fails on an unlisted file, reads a deleted tracked file from the index, and passes when clean', () => {
  const root = mkdtempSync(join(tmpdir(), 'machine-paths-'));
  try {
    const git = (...args) => execFileSync('git', args, { cwd: root, stdio: 'ignore' });
    git('init', '-q');
    writeFileSync(join(root, 'clean.md'), 'nothing here');
    writeFileSync(join(root, 'dirty.md'), `path ${samples[5]}`);
    writeFileSync(join(root, 'gone.md'), `path ${samples[0]}`);
    git('add', '-A');
    rmSync(join(root, 'gone.md'));
    assert.throws(
      () => checkMachinePaths(root),
      (error) => /dirty\.md:1/.test(error.message) && /gone\.md:1/.test(error.message)
    );
    assert.throws(() => checkMachinePaths(root, ['missing-everywhere.md']), /unreadable/);
    assert.doesNotThrow(() => checkMachinePaths(root, ['clean.md']));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('production files beside allow-listed material are still scanned', () => {
  const beside = [
    'apps/desktop/src/renderer/remote-protocol-files.ts',
    'apps/desktop/src/renderer/transcript-tool-ui.tsx',
    'apps/desktop/src/renderer/other.record.mjs',
    'apps/desktop/src/renderer/remote-protocol-chat-history.node.ts',
    'apps/desktop/src/main/protocol/service-route.ts',
    'packages/protocol-client/test/live-turn-other.json',
    'native/core/crates/mixdog-entry/src/main.rs',
    'native/mixdog-browser-import/dist/other.exe',
    'benchmarks/terminal-bench-2.1/records-extra/a.json',
  ];
  assert.equal(scan(beside, () => samples[5]).length, beside.length);
});

test('the allow-listed material itself is exempt', () => {
  const exempt = [
    'apps/desktop/src/renderer/remote-protocol-chat-roster.node/01.json',
    'apps/desktop/src/renderer/remote-protocol-chat.record.mjs',
    'apps/mobile/fixtures/phone-files/golden.json',
    'benchmarks/terminal-bench-2.1/records/run/out.log',
  ];
  assert.deepEqual(
    scan(exempt, () => samples[5]),
    []
  );
});

test('every allow-list entry states why', () => {
  for (const entry of ALLOW) {
    assert.ok(entry.path instanceof RegExp);
    assert.ok(entry.why.length > 20);
  }
});
