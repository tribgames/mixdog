import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import fsPromises from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const root = mkdtempSync(join(tmpdir(), 'mixdog-read-cache-encoding-'));
process.env.MIXDOG_DATA_DIR = join(root, 'data');
process.env.MIXDOG_AGENT_TRACE_DISABLE = '1';
process.env.MIXDOG_PATCH_NATIVE_PREWARM = '0';
const { executeBuiltinTool } = await import('../builtin.mjs');
const { invalidateBuiltinResultCache, rawContentCacheGet, registerCacheInvalidationListener } = await import(
  './cache-layers.mjs'
);
process.once('exit', () => rmSync(root, { recursive: true, force: true }));
test.afterEach(() => invalidateBuiltinResultCache());

const encodings = [
  { name: 'UTF-8', unit: 1, encode: (text) => Buffer.from(text) },
  {
    name: 'UTF-8 BOM',
    unit: 1,
    encode: (text) => Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text)]),
  },
  {
    name: 'UTF-16 LE',
    unit: 2,
    encode: (text) => Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]),
  },
  {
    name: 'UTF-16 BE',
    unit: 2,
    encode: (text) => Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(text, 'utf16le').swap16()]),
  },
];

for (const { name, unit, encode } of encodings) {
  for (const size of [0, 65536 - unit, 65536, 65536 + unit]) {
    for (const ranged of [false, true]) {
      test(`${name} cache retains unchanged bytes and rejects rewrites (bytes=${size || 'small'}, ranged=${ranged})`, async (t) => {
        const base = 'BEFORE 한글 😀\n';
        const text = base + (size ? 'x'.repeat((size - encode(base).length) / unit) : '');
        const bytes = encode(text);
        if (size) assert.equal(bytes.length, size);
        const path = join(root, `${randomUUID()}.txt`);
        writeFileSync(path, bytes);
        const time = new Date('2025-01-01T00:00:00.000Z');
        utimesSync(path, time, time);
        const before = statSync(path);
        const originalStat = fsPromises.stat;
        const mock = t.mock.method(fsPromises, 'stat', async (target, ...options) => {
          const st = await originalStat(target, ...options);
          if (target === path) st.ctimeMs = before.ctimeMs;
          return st;
        });
        syncBuiltinESMExports();
        let unsubscribe;
        try {
          const args = { file_path: path, ...(ranged ? { offset: 1, limit: 1 } : {}) };
          const options = { sessionId: randomUUID(), suppressReadUnchangedStub: true };
          const first = String(await executeBuiltinTool('read', args, root, options));
          assert.match(first, /BEFORE 한글 😀/);
          const cachedRaw = rawContentCacheGet(path, before);
          assert.deepEqual(cachedRaw, bytes);
          let invalidations = 0;
          unsubscribe = registerCacheInvalidationListener(() => invalidations++);
          assert.equal(String(await executeBuiltinTool('read', args, root, options)), first);
          assert.equal(invalidations, 0, 'unchanged encoded bytes must not invalidate caches');
          assert.equal(rawContentCacheGet(path, before), cachedRaw, 'unchanged reads retain raw reuse');

          const replacement = encode(text.replace('BEFORE', 'AFTER_'));
          writeFileSync(path, replacement);
          utimesSync(path, time, time);
          const observed = await fsPromises.stat(path);
          for (const field of ['mtimeMs', 'ctimeMs', 'size', 'ino', 'dev']) {
            assert.equal(observed[field], before[field], `${field} must collide`);
          }
          const reread = String(await executeBuiltinTool('read', args, root, options));
          assert.equal(reread, first.replace('BEFORE', 'AFTER_'));
          assert.equal(invalidations, 1, 'changed bytes still reject the cached result');
          assert.deepEqual(rawContentCacheGet(path, observed), replacement);
        } finally {
          unsubscribe?.();
          mock.mock.restore();
          syncBuiltinESMExports();
        }
      });
    }
  }
}
