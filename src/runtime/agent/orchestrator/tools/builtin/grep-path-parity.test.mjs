import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executeGrepTool } from './search-grep-tool.mjs';
import { invalidateBuiltinResultCache } from './cache-layers.mjs';

test('filtered multi-path searches retain legacy results across scope and paging boundaries', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-path-parity-'));
  const previous = process.env.MIXDOG_GREP_PATH_COMBINED;
  t.after(() => {
    if (previous === undefined) delete process.env.MIXDOG_GREP_PATH_COMBINED;
    else process.env.MIXDOG_GREP_PATH_COMBINED = previous;
    invalidateBuiltinResultCache();
    rmSync(root, { recursive: true, force: true });
  });
  mkdirSync(join(root, '.git'));
  for (const dir of ['one', 'two']) {
    mkdirSync(join(root, dir, 'nested'), { recursive: true });
    mkdirSync(join(root, dir, 'ignored'));
    writeFileSync(join(root, dir, '.gitignore'), 'ignored/\n');
    for (const file of ['a.txt', 'skip.txt', 'other.rs', 'nested/deep.txt', 'ignored/hidden.txt']) {
      writeFileSync(join(root, dir, file), 'needle first\nmiddle\nneedle last\n');
    }
    writeFileSync(join(root, dir, 'binary.dat'), Buffer.from('\0needle binary\n'));
  }
  const cases = [
    { glob: '*.txt' },
    { glob: ['*.txt', '!skip.txt'] },
    { glob: 'nested/*.txt' },
    { glob: ['*.txt', '!nested/**'] },
    { glob: '*.txt', include_noise: true },
    { glob: ['*.txt', '*.dat'], text: true },
    { glob: '*.txt', path: [join(root, 'one'), join(root, 'two')] },
    { glob: '*.txt', path: ['one/other.rs', 'two'] },
    { glob: '*.txt', path: ['one', 'one/nested'] },
    { glob: '*.txt', pattern: 'absent' },
    { glob: '*.txt', mode: 'content', context: 0 },
    { glob: '*.txt', mode: 'content', context: 2 },
    { glob: 'a.txt', mode: 'content', context: 0, limit: 1 },
    { glob: 'a.txt', mode: 'content', context: 0, offset: 1, limit: 1 },
  ];
  // Native parallel scanning may discover files in a different order. Compare
  // complete file sets / context blocks rather than treating discovery order
  // as a guaranteed ordering contract. A complete scan can report an exact
  // total where a bounded legacy scan only knows that more matches exist;
  // check paging separately against the fixture's two matching lines.
  const normalized = (value) => String(value).replaceAll('\\', '/').split('\n')
    .filter((line) => line && !/^\[\d+(?: of \d+)? shown/.test(line)).sort();
  for (const args of cases) {
    const search = () => executeGrepTool({
      pattern: 'needle', path: ['one', 'two'], mode: 'files', limit: 100, ...args,
    }, root);
    process.env.MIXDOG_GREP_PATH_COMBINED = '0';
    invalidateBuiltinResultCache();
    const legacy = await search();
    delete process.env.MIXDOG_GREP_PATH_COMBINED;
    invalidateBuiltinResultCache();
    const combined = await search();
    assert.doesNotMatch(combined, /Error:|unsupported|timed out/, JSON.stringify(args));
    assert.deepEqual(normalized(combined), normalized(legacy), JSON.stringify(args));
    if (args.limit === 1 && !args.offset) {
      assert.equal((combined.match(/\[1 of 2 shown; offset:1 for the rest\]/g) || []).length, 2);
      assert.doesNotMatch(combined, /needle last/);
    }
    if (args.offset === 1) {
      assert.equal((combined.match(/3:\s*needle last/g) || []).length, 2);
      assert.doesNotMatch(combined, /needle first/);
    }
  }
});

for (const context of [0, 2, undefined]) {
  test(`unwatchable single-file grep stays complete but cannot be cached (context=${context})`, async (t) => {
    const root = mkdtempSync(join(tmpdir(), 'mixdog-grep-unwatched-'));
    const file = join(root, 'single.txt');
    t.after(() => {
      invalidateBuiltinResultCache();
      rmSync(root, { recursive: true, force: true });
    });
    for (const value of ['needle original', 'needle externally updated']) {
      writeFileSync(file, value + '\n');
      const outcome = { complete: true, cacheSafe: true };
      const result = await executeGrepTool(
        { path: file, pattern: 'needle', output_mode: 'content', ...(context === undefined ? {} : { context }) },
        root, undefined, null, { scopedCacheOutcome: outcome }
      );
      assert.ok(result.includes(value), result);
      assert.equal(outcome.complete, true);
      assert.equal(outcome.cacheSafe, false, 'the native engine deliberately does not watch exact-file operands');
    }
  });
}
