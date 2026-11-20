import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { filePatterns, unmatchedPatterns } from './explicit-test-files.mjs';

test('file patterns are the arguments that are neither flags nor the values of flags', () => {
  assert.deepEqual(
    filePatterns([
      '--import',
      'file:///x/setup.mjs',
      '--test-name-pattern',
      'parsing',
      '--test-force-exit',
      '--test-timeout=5',
      'a.test.mjs',
      'dir/*.test.mjs',
      '--import',
      './loader.mjs',
      'parsing',
    ]),
    ['a.test.mjs', 'dir/*.test.mjs']
  );
});

test('a named file or a glob that matches nothing is reported, one that matches is not', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'explicit-test-files-'));
  try {
    mkdirSync(join(cwd, 'present'));
    writeFileSync(join(cwd, 'present', 'a.test.mjs'), '');
    writeFileSync(join(cwd, 'b.test.mjs'), '');
    assert.deepEqual(
      unmatchedPatterns(['present/*.test.mjs', 'b.test.mjs', 'gone/*.test.mjs', 'gone.test.mjs', '--test-force-exit'], {
        cwd,
      }),
      ['gone/*.test.mjs', 'gone.test.mjs']
    );
    assert.deepEqual(unmatchedPatterns([], { cwd }), []);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
