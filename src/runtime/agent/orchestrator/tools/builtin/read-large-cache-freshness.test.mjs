import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import { mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import fsPromises from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

const root = mkdtempSync(join(tmpdir(), 'mixdog-large-read-cache-'));
process.env.MIXDOG_DATA_DIR = join(root, 'data');
process.env.MIXDOG_AGENT_TRACE_DISABLE = '1';
process.env.MIXDOG_PATCH_NATIVE_PREWARM = '0';
const { executeBuiltinTool } = await import('../builtin.mjs');
const { invalidateBuiltinResultCache } = await import('./cache-layers.mjs');
const { fileVersion } = await import('./file-version.mjs');
const { getReadSnapshot, recordReadSnapshot } = await import('./read-snapshot-runtime.mjs');
process.once('exit', () => rmSync(root, { recursive: true, force: true }));

const time = new Date('2025-01-01T00:00:00.000Z');
const FIELDS = ['mtimeMs', 'ctimeMs', 'size', 'ino', 'dev'];
const hash = (value) => createHash('sha256').update(value).digest('hex');
const shapes = [
  { name: 'buffered UTF-8', encoding: 'utf8', streamed: false, source: 'read' },
  { name: 'buffered UTF-16 LE', encoding: 'utf16le', streamed: false, source: 'read' },
  { name: 'buffered UTF-16 BE', encoding: 'utf16be', streamed: false, source: 'read' },
  { name: 'streamed UTF-8', encoding: 'utf8', streamed: true, source: 'read_stream_range' },
];

function encode(encoding, text) {
  if (encoding === 'utf8') return Buffer.from(text);
  const body = Buffer.from(text, 'utf16le');
  return encoding === 'utf16le'
    ? Buffer.concat([Buffer.from([0xff, 0xfe]), body])
    : Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(body).swap16()]);
}

function tokenOffset(bytes, token, encoding) {
  const encoded = encoding === 'utf8' ? Buffer.from(token) : Buffer.from(token, 'utf16le');
  return bytes.indexOf(encoding === 'utf16be' ? Buffer.from(encoded).swap16() : encoded);
}

function lineCountOf(text) {
  return text.endsWith('\n') ? text.split('\n').length - 1 : text.split('\n').length;
}

// Prefix occupies the first 64KiB. Requested lines stay short so a coalesced
// union fits the output budget; only the deep token changes.
function buildFixture(encoding, streamed) {
  const unit = encoding === 'utf8' ? 1 : 2;
  const bom = encoding === 'utf8' ? 0 : 2;
  const prefixChars = (65536 - bom) / unit;
  const pad = streamed ? `${'b'.repeat(40000)}\n`.repeat(2) : '';
  const text = `${'a'.repeat(prefixChars - 1)}\n${pad}GAP_____\nOMITTED_\nDEEP_BEFORE\n`;
  const lines = text.split('\n');
  lines.pop();
  return {
    text,
    lines,
    deepLine: lines.indexOf('DEEP_BEFORE') + 1,
    gapLine: lines.indexOf('GAP_____') + 1,
  };
}

function pinIdentity(t, path, ctimeMs) {
  const originalStat = fsPromises.stat;
  const statMock = t.mock.method(fsPromises, 'stat', async (target, ...args) => {
    const st = await originalStat(target, ...args);
    if (target === path) st.ctimeMs = ctimeMs;
    return st;
  });
  // Batch reads stream below 128KiB. FileHandle.stat is fstat, so it does not
  // observe the fsPromises.stat ctime pin.
  const originalOpen = fsPromises.open;
  const openMock = t.mock.method(fsPromises, 'open', async (target, ...args) => {
    const handle = await originalOpen(target, ...args);
    if (target === path) {
      const bound = handle.stat.bind(handle);
      handle.stat = async (...statArgs) => {
        const st = await bound(...statArgs);
        st.ctimeMs = ctimeMs;
        return st;
      };
    }
    return handle;
  });
  syncBuiltinESMExports();
  return () => {
    statMock.mock.restore();
    openMock.mock.restore();
    syncBuiltinESMExports();
  };
}

function prepare(t, shape) {
  const built = buildFixture(shape.encoding, shape.streamed);
  const original = encode(shape.encoding, built.text);
  assert.ok(original.length > 65536, 'fixture must exceed the prefix validator');
  if (shape.streamed)
    assert.ok(original.length > 128 * 1024, 'streamed fixture must exceed the range-stream threshold');
  else assert.ok(original.length <= 128 * 1024, 'buffered fixture must stay on the in-memory path');
  assert.equal(tokenOffset(original, 'DEEP_BEFORE', shape.encoding) > 65536, true);
  const path = join(root, `${randomUUID()}.txt`);
  writeFileSync(path, original);
  utimesSync(path, time, time);
  const before = statSync(path);
  const restore = pinIdentity(t, path, before.ctimeMs);
  return { ...built, ...shape, path, original, before, restore };
}

async function rewriteDeep(fx) {
  const nextText = fx.text.replace('DEEP_BEFORE', 'DEEP_AFTER_');
  const nextBytes = encode(fx.encoding, nextText);
  writeFileSync(fx.path, nextBytes);
  utimesSync(fx.path, time, time);
  assert.equal(nextBytes.length, fx.original.length, 'rewrite must keep the same size');
  assert.deepEqual(nextBytes.subarray(0, 65536), fx.original.subarray(0, 65536), 'initial 64KiB bytes stay unchanged');
  assert.equal(tokenOffset(nextBytes, 'DEEP_AFTER_', fx.encoding) > 65536, true);
  assert.deepEqual(readFileSync(fx.path), nextBytes);
  const observed = await fsPromises.stat(fx.path);
  for (const field of FIELDS) assert.equal(observed[field], fx.before[field], `${field} must collide`);
  const handle = await fsPromises.open(fx.path, 'r');
  try {
    const borrowedStat = await handle.stat();
    for (const field of FIELDS)
      assert.equal(borrowedStat[field], fx.before[field], 'borrowed ' + field + ' must collide');
  } finally {
    await handle.close();
  }

  return observed;
}

function assertWindow(snapshot, observed, { source, line, text }) {
  assert.ok(snapshot, 'the fresh read must record its own snapshot');
  assert.equal(snapshot.source, source);
  for (const field of FIELDS) assert.equal(snapshot[field], observed[field]);
  assert.equal(snapshot.contentHash, undefined);
  assert.notEqual(snapshot.bodyDelivered, true);
  assert.deepEqual(snapshot.ranges, [{ startLine: line, endLine: line }]);
  assert.deepEqual(snapshot.rangeHashes, [{ startLine: line, endLine: line, hash: hash(text) }]);
}

function assertDelivered(snapshot, observed, parts) {
  assert.ok(snapshot, 'the coalesced batch must record exact delivered evidence');
  assert.equal(snapshot.source, 'read_batch_sliced');
  for (const field of FIELDS) assert.equal(snapshot[field], observed[field]);
  assert.equal(snapshot.contentHash, undefined);
  assert.equal(snapshot.fileLineCount, undefined);
  assert.notEqual(snapshot.bodyDelivered, true);
  assert.deepEqual(
    snapshot.ranges,
    parts.map(({ line }) => ({ startLine: line, endLine: line }))
  );
  assert.deepEqual(
    snapshot.rangeHashes,
    parts.map(({ line, text }) => ({
      startLine: line,
      endLine: line,
      hash: hash(text),
    }))
  );
}

function seedHonestMutation(path, st, scope, text) {
  const fileLineCount = lineCountOf(text);
  const contentHash = hash(text);
  recordReadSnapshot(path, st, scope, {
    source: 'read',
    ranges: [{ startLine: 1, endLine: Infinity }],
    contentHash,
    fileLineCount,
  });
  recordReadSnapshot(path, st, scope, {
    source: 'edit',
    ranges: [{ startLine: 1, endLine: Infinity }],
    contentHash,
    preMutationStat: fileVersion(st),
    fileLineCount,
  });
  const seeded = getReadSnapshot(path, scope);
  assert.equal(seeded.source, 'edit');
  assert.equal(seeded.bodyDelivered, true);
  assert.equal(seeded.contentHash, contentHash);
  assert.ok(seeded.ranges.some((range) => range.startLine <= 1 && range.endLine === Infinity));
}

describe('large-file read cache freshness', { concurrency: false }, () => {
  test.afterEach(() => invalidateBuiltinResultCache());

  for (const shape of shapes) {
    test(`same window returns the deep rewrite (${shape.name})`, async (t) => {
      const fx = prepare(t, shape);
      const sessionId = randomUUID();
      const options = { sessionId, suppressReadUnchangedStub: true };
      const args = { file_path: fx.path, offset: fx.deepLine, limit: 1 };
      try {
        const first = String(await executeBuiltinTool('read', args, root, options));
        assert.match(first, /DEEP_BEFORE/);
        assert.doesNotMatch(first, /DEEP_AFTER_|a{200}|OMITTED_/);
        assertWindow(getReadSnapshot(fx.path, sessionId), await fsPromises.stat(fx.path), {
          source: shape.source,
          line: fx.deepLine,
          text: 'DEEP_BEFORE',
        });
        const observed = await rewriteDeep(fx);
        const second = String(await executeBuiltinTool('read', args, root, options));
        assert.match(second, /DEEP_AFTER_/);
        assert.doesNotMatch(second, /DEEP_BEFORE|a{200}|OMITTED_/);
        assertWindow(getReadSnapshot(fx.path, sessionId), observed, {
          source: shape.source,
          line: fx.deepLine,
          text: 'DEEP_AFTER_',
        });
      } finally {
        fx.restore();
      }
    });

    test(`different window returns the deep rewrite (${shape.name})`, async (t) => {
      const fx = prepare(t, shape);
      const sessionId = randomUUID();
      const options = { sessionId, suppressReadUnchangedStub: true };
      try {
        const first = String(
          await executeBuiltinTool(
            'read',
            {
              file_path: fx.path,
              offset: fx.gapLine,
              limit: 1,
            },
            root,
            options
          )
        );
        assert.match(first, /GAP_____/);
        assert.doesNotMatch(first, /DEEP_BEFORE|OMITTED_/);
        assertWindow(getReadSnapshot(fx.path, sessionId), await fsPromises.stat(fx.path), {
          source: shape.source,
          line: fx.gapLine,
          text: 'GAP_____',
        });
        const observed = await rewriteDeep(fx);
        const second = String(
          await executeBuiltinTool(
            'read',
            {
              file_path: fx.path,
              offset: fx.deepLine,
              limit: 1,
            },
            root,
            options
          )
        );
        assert.match(second, /DEEP_AFTER_/);
        assert.doesNotMatch(second, /DEEP_BEFORE|GAP_____|OMITTED_|a{200}/);
        assertWindow(getReadSnapshot(fx.path, sessionId), observed, {
          source: shape.source,
          line: fx.deepLine,
          text: 'DEEP_AFTER_',
        });
      } finally {
        fx.restore();
      }
    });

    test(`coalesced batch keeps only delivered lines (${shape.name})`, async (t) => {
      const fx = prepare(t, shape);
      const sessionId = randomUUID();
      const options = { sessionId, suppressReadUnchangedStub: true };
      const args = {
        file_path: [
          { file_path: fx.path, offset: fx.gapLine, limit: 1 },
          { file_path: fx.path, offset: fx.deepLine, limit: 1 },
        ],
      };
      try {
        const first = String(await executeBuiltinTool('read', args, root, options));
        assert.match(first, /GAP_____/);
        assert.match(first, /DEEP_BEFORE/);
        assert.doesNotMatch(first, /OMITTED_|a{200}/);
        const observed = await rewriteDeep(fx);
        const second = String(await executeBuiltinTool('read', args, root, options));
        assert.match(second, /GAP_____/);
        assert.match(second, /DEEP_AFTER_/);
        assert.doesNotMatch(second, /DEEP_BEFORE|OMITTED_|a{200}/);
        assertDelivered(getReadSnapshot(fx.path, sessionId), observed, [
          { line: fx.gapLine, text: 'GAP_____' },
          { line: fx.deepLine, text: 'DEEP_AFTER_' },
        ]);
      } finally {
        fx.restore();
      }
    });
  }

  test('a large-file mutation snapshot cannot hide a colliding deep rewrite', async (t) => {
    const fx = prepare(t, shapes[0]);
    const sessionId = randomUUID();
    try {
      seedHonestMutation(fx.path, fx.before, sessionId, fx.text);
      const observed = await rewriteDeep(fx);
      const out = String(
        await executeBuiltinTool(
          'read',
          {
            file_path: fx.path,
            offset: fx.deepLine,
            limit: 1,
          },
          root,
          { sessionId }
        )
      );
      assert.match(out, /DEEP_AFTER_/);
      assert.doesNotMatch(out, /DEEP_BEFORE|\[file unchanged:/);
      assertWindow(getReadSnapshot(fx.path, sessionId), observed, {
        source: 'read',
        line: fx.deepLine,
        text: 'DEEP_AFTER_',
      });
    } finally {
      fx.restore();
    }
  });

  test('a small-file mutation snapshot still returns the unchanged stub', async () => {
    const path = join(root, `${randomUUID()}.txt`);
    const text = 'HELLO\n';
    writeFileSync(path, text);
    utimesSync(path, time, time);
    const sessionId = randomUUID();
    seedHonestMutation(path, statSync(path), sessionId, text);
    const out = String(await executeBuiltinTool('read', { file_path: path }, root, { sessionId }));
    assert.match(out, /\[file unchanged:/);
    assert.doesNotMatch(out, /HELLO/);
  });

  for (const shape of shapes.filter((shape) => !shape.streamed && shape.encoding !== 'utf16be')) {
    test(`a fresh partial read drops the prior full snapshot (${shape.name})`, async (t) => {
      const fx = prepare(t, shape);
      const sessionId = randomUUID();
      const priorHash = hash(fx.text);
      try {
        recordReadSnapshot(fx.path, fx.before, sessionId, {
          source: 'read',
          ranges: [{ startLine: 1, endLine: Infinity }],
          contentHash: priorHash,
          fileLineCount: fx.lines.length,
        });
        const seeded = getReadSnapshot(fx.path, sessionId);
        assert.equal(seeded.contentHash, priorHash);
        assert.equal(seeded.bodyDelivered, true);
        assert.deepEqual(seeded.ranges, [{ startLine: 1, endLine: Infinity }]);
        const observed = await rewriteDeep(fx);
        const out = String(
          await executeBuiltinTool(
            'read',
            {
              file_path: fx.path,
              offset: fx.deepLine,
              limit: 1,
            },
            root,
            { sessionId, suppressReadUnchangedStub: true }
          )
        );
        assert.match(out, /DEEP_AFTER_/);
        assert.doesNotMatch(out, /DEEP_BEFORE/);
        const snapshot = getReadSnapshot(fx.path, sessionId);
        assert.notEqual(snapshot?.contentHash, priorHash);
        assertWindow(snapshot, observed, {
          source: 'read',
          line: fx.deepLine,
          text: 'DEEP_AFTER_',
        });
      } finally {
        fx.restore();
      }
    });
  }
});
