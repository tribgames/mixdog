import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

const root = mkdtempSync(join(tmpdir(), 'mixdog-batch-complete-lines-'));
process.env.MIXDOG_DATA_DIR = join(root, 'data');
process.env.MIXDOG_AGENT_TRACE_DISABLE = '1';
process.env.MIXDOG_PATCH_NATIVE_PREWARM = '0';
const { executeBuiltinTool } = await import('../builtin.mjs');
const { getReadSnapshot, isSnapshotStale } = await import('./read-snapshot-runtime.mjs');
const { invalidateBuiltinResultCache, runReadCachePublication } = await import('./cache-layers.mjs');
const { runBatchReadSnapshotPublication } = await import('./read-tool/batch-publication.mjs');
const { recordSlicedBatchSnapshots } = await import('./read-tool/batch-snapshot.mjs');
const { mergeReadRanges } = await import('./read-ranges.mjs');
const { rangeHashesFromRenderedReadText } = await import('./snapshot-helpers.mjs');
process.once('exit', () => rmSync(root, { recursive: true, force: true }));
test.afterEach(() => invalidateBuiltinResultCache());

const hash = (text) => createHash('sha256').update(text).digest('hex');

function encode(text, encoding) {
  const body = Buffer.from(text, 'utf16le');
  return encoding === 'utf16le'
    ? Buffer.concat([Buffer.from([0xff, 0xfe]), body])
    : Buffer.concat([Buffer.from([0xfe, 0xff]), body.swap16()]);
}

for (const encoding of ['utf16le', 'utf16be']) {
  for (const coalesced of [false, true]) {
    test(`batch excludes a byte-capped partial line (${encoding}, coalesced:${coalesced})`, async () => {
      const path = join(root, `${randomUUID()}.txt`);
      const content = `FIRST\n${'x'.repeat(600)}\nGAP\nLAST\n`;
      writeFileSync(path, encode(content, encoding));
      const args = {
        file_path: coalesced
          ? [
              { file_path: path, offset: 1, limit: 2 },
              { file_path: path, offset: 4, limit: 1 },
            ]
          : [{ file_path: path, offset: 1, limit: 4 }],
      };
      const options = { sessionId: randomUUID(), readOutputBudgetBytes: 512, suppressReadUnchangedStub: true };
      const output = String(await executeBuiltinTool('read', args, root, options));
      assert.match(output, /FIRST/);
      assert.match(output, /x{20}/, 'the partial second row is still shown to the caller');
      assert.doesNotMatch(output, /x{600}|GAP|LAST/);
      const expectedRanges = [{ startLine: 1, endLine: 1 }];
      const expectedHashes = [{ startLine: 1, endLine: 1, hash: hash('FIRST') }];
      const snapshot = getReadSnapshot(path, options.sessionId);
      assert.deepEqual(snapshot.ranges, expectedRanges);
      assert.deepEqual(snapshot.rangeHashes, expectedHashes);
      assert.equal(snapshot.contentHash, undefined);
      assert.notEqual(snapshot.bodyDelivered, true);

      assert.equal(String(await executeBuiltinTool('read', args, root, options)), output);
      const cachedSnapshot = getReadSnapshot(path, options.sessionId);
      assert.deepEqual(cachedSnapshot.ranges, expectedRanges);
      assert.deepEqual(cachedSnapshot.rangeHashes, expectedHashes);

      const time = new Date('2020-01-01T00:00:00.000Z');
      utimesSync(path, time, time);
      assert.notEqual(statSync(path).mtimeMs, cachedSnapshot.mtimeMs);
      assert.equal(
        isSnapshotStale(statSync(path), cachedSnapshot, path),
        false,
        'metadata-only drift must not reject unchanged complete lines'
      );
      writeFileSync(path, encode(content.replace('FIRST', 'OTHER'), encoding));
      const later = new Date('2021-01-01T00:00:00.000Z');
      utimesSync(path, later, later);
      assert.equal(
        isSnapshotStale(statSync(path), cachedSnapshot, path),
        true,
        'changes to the complete delivered line must still be detected'
      );
    });
  }
}

test('a batch containing only a partial first row records no complete-line evidence', async () => {
  const path = join(root, `${randomUUID()}.txt`);
  writeFileSync(path, encode(`${'x'.repeat(600)}\nLAST\n`, 'utf16le'));
  const options = { sessionId: randomUUID(), readOutputBudgetBytes: 512, suppressReadUnchangedStub: true };
  const output = String(
    await executeBuiltinTool(
      'read',
      {
        file_path: [{ file_path: path, offset: 1, limit: 2 }],
      },
      root,
      options
    )
  );
  assert.match(output, /x{20}/);
  assert.doesNotMatch(output, /x{600}|LAST/);
  const snapshot = getReadSnapshot(path, options.sessionId);
  assert.deepEqual(snapshot?.ranges ?? [], []);
  assert.equal(snapshot?.contentHash, undefined);
  assert.notEqual(snapshot?.bodyDelivered, true);
});

for (const scenario of ['same-path producers', 'elided middle', 'full-file producer']) {
  test(`batch complete-line filtering preserves ${scenario}`, async () => {
    const path = join(root, `${randomUUID()}.txt`);
    const scope = randomUUID();
    const identity = { mtimeMs: 1, ctimeMs: 2, size: 20, ino: 3, dev: 4 };
    const entries = scenario === 'same-path producers' ? [{ path }, { path }] : [{ path }];
    const bodies =
      scenario === 'same-path producers'
        ? ['1→FIRST\n2→PAR', '2→COMPLETE']
        : ['1→FIRST\n... omitted ...\n3→LAST\n[lines 1-3 of 3]'];
    const certified =
      scenario === 'same-path producers'
        ? [[{ startLine: 1, endLine: 1 }], [{ startLine: 2, endLine: 2 }]]
        : [[{ startLine: 1, endLine: scenario === 'full-file producer' ? Infinity : 3 }]];
    let saved;
    const helpers = {
      resolveAgainstCwd: (path) => path,
      classifyResultKind: () => 'text',
      _hashText: hash,
      _mergeReadRanges: mergeReadRanges,
      _rangeHashesFromRenderedReadText: rangeHashesFromRenderedReadText,
      _recordReadSnapshot: (_path, _st, _scope, meta) => {
        saved = meta;
      },
    };
    const child = (_name, args, _cwd, options) =>
      runReadCachePublication(path, async () => {
        const index = entries.indexOf(args);
        options._readSnapshotRecorder(path, identity, scope, { ranges: certified[index] });
        return bodies[index];
      });
    const output = await runBatchReadSnapshotPublication(child, helpers, async (executeChild, snapshotHelpers) => {
      const results = [];
      for (const readEntry of entries) {
        results.push({
          path,
          mode: 'full',
          readEntry,
          body: await executeChild('read', readEntry, root),
        });
      }
      await recordSlicedBatchSnapshots(results, root, scope, snapshotHelpers);
      return results.map((result) => result.body).join('\n');
    });
    assert.equal(output, bodies.join('\n'), 'evidence filtering must not rewrite delivered text');
    const lastLine = scenario === 'same-path producers' ? 2 : 3;
    assert.deepEqual(
      saved.ranges,
      mergeReadRanges([
        { startLine: 1, endLine: 1 },
        { startLine: lastLine, endLine: lastLine },
      ])
    );
    assert.deepEqual(saved.rangeHashes, [
      { startLine: 1, endLine: 1, hash: hash('FIRST') },
      { startLine: lastLine, endLine: lastLine, hash: hash(lastLine === 2 ? 'COMPLETE' : 'LAST') },
    ]);
  });
}
