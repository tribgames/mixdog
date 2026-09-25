import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { writeFileSync } from 'node:fs';

import { analyzeShellCommandEffects, preflightShellLargeFileProbe } from './shell-analysis.mjs';

function workDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'shell-effects-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('path mutators and redirects report the paths they write', async (t) => {
  const dir = workDir(t);
  for (const [command, file] of [
    ['touch a.txt', 'a.txt'],
    ['echo hi > out.txt', 'out.txt'],
    ['echo hi | tee log.txt', 'log.txt'],
    ['cp a.txt b.txt', 'b.txt'],
  ]) {
    const effects = await analyzeShellCommandEffects(command, dir);
    assert.equal(effects.mutationMode, 'paths', command);
    assert.ok(effects.paths.includes(join(dir, file)), `${command}: ${JSON.stringify(effects.paths)}`);
  }
});

test('a mutator without resolvable path arguments is a global mutation', async (t) => {
  const effects = await analyzeShellCommandEffects('rm', workDir(t));
  assert.equal(effects.mutationMode, 'global');
});

test('grep -A/-B/-C values are option values, not the pattern', async (t) => {
  const dir = workDir(t);
  // A large file named like the pattern: probing it as a target would block.
  writeFileSync(join(dir, 'big.txt'), 'x'.repeat(64 * 1024));
  writeFileSync(join(dir, 'small.txt'), 'x\n');
  for (const flag of ['-A', '-B', '-C']) {
    assert.equal(await preflightShellLargeFileProbe(`grep ${flag} 5 big.txt small.txt`, dir), null, flag);
  }
  // The large file as a real target is still probed.
  const blocked = await preflightShellLargeFileProbe('grep -A 5 needle big.txt', dir);
  assert.equal(blocked?.path, join(dir, 'big.txt'));
});

test('read-only commands and cd leave nothing mutated', async (t) => {
  const dir = workDir(t);
  const effects = await analyzeShellCommandEffects('cat a.txt', dir);
  assert.deepEqual(effects, { mutationMode: 'none', paths: [], finalCwd: dir });
});
