import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classify, parseLog } from './k1-failing-tests.mjs';

const dir = mkdtempSync(join(tmpdir(), 'k1-classify-'));
// A test process that died on a thrown string: stderr has no "Error:" line, so the log gives no reason.
const exitedLog = (name, thrown) => {
  const path = join(dir, name);
  writeFileSync(
    path,
    [
      `Uncaught '${thrown}'`,
      'node:internal/process/execution:1',
      '✖ src/x.test.mjs (5.1ms)',
      '[failure-summary] FAILED src/x.test.mjs > src/x.test.mjs (test process exited with code 1)',
      '',
    ].join('\n')
  );
  return parseLog(path);
};

test('two failures with different thrown strings and no Error line are class c, not matched to each other', () => {
  const run = exitedLog('run.log', 'first');
  const reference = exitedLog('ref.log', 'second');
  assert.equal(run.get('src/x.test.mjs')[0].reason, null);
  assert.equal(classify('src/x.test.mjs', run, reference, new Set()).cls, 'c');
});

test('even the same missing reason on both sides is class c; an identical stated reason is class b', () => {
  const same = exitedLog('same.log', 'first');
  assert.equal(classify('src/x.test.mjs', same, same, new Set()).cls, 'c');
  const failure = (reason) => new Map([['f.mjs', [{ name: 't', reason }]]]);
  assert.equal(classify('f.mjs', failure('boom'), failure('boom'), new Set()).cls, 'b');
  assert.equal(classify('f.mjs', failure('boom'), failure('boom'), new Set(['f.mjs'])).cls, 'a');
});
