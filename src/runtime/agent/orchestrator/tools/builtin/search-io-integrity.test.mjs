import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate as nextTurn } from 'node:timers/promises';

const root = await fs.mkdtemp(join(tmpdir(), 'mixdog-search-io-test-'));
process.env.MIXDOG_DATA_DIR = join(root, 'data');
const { readSourceWindows } = await import('./read-source-windows.mjs');
const { prepareGrepContextSources, expandGrepAnchorContextOutput } = await import('./lib/grep-context-expander.mjs');
const { runGrepPatternFanout } = await import('./lib/grep-pattern-fanout.mjs');
const { executeGrepTool } = await import('./search-grep-tool.mjs');
const { executeBuiltinTool } = await import('../builtin.mjs');
const { flushReadRangeIndexesSync } = await import('./read-range-index.mjs');
const { readRowsForDisplay } = await import('../../../../shared/read-row-numbers.mjs');

after(async () => {
  flushReadRangeIndexesSync();
  await fs.rm(root, { recursive: true, force: true });
});

function mockFs(t, name, implementation) {
  t.mock.method(fs, name, implementation);
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
}

function contextOptions(overrides = {}) {
  return {
    workDir: root,
    rgSpawnCwd: root,
    grepResolvedPath: root,
    searchPath: '.',
    outputMode: 'content',
    filenameOmitted: false,
    headLimit: 10,
    offset: 0,
    requestedContext: 2,
    maxContext: 2,
    ...overrides,
  };
}

function fanoutOptions(overrides = {}) {
  return {
    args: {},
    patterns: ['alpha', 'beta'],
    workDir: root,
    readStateScope: null,
    options: {},
    executeChildBuiltinTool: async () => '',
    callContextCharBudget: 4096,
    patternCapNote: '',
    searchPath: '.',
    grepResolvedPath: root,
    normalizedGlobPatterns: [],
    outputMode: 'content',
    headLimit: 10,
    offset: 0,
    caseInsensitive: false,
    showLineNumbers: true,
    beforeN: null,
    afterN: null,
    contextN: 0,
    multilineMode: false,
    pcre2Mode: false,
    fileType: '',
    executeGrepTool: async () => {
      throw new Error('unexpected fallback');
    },
    ...overrides,
  };
}

test('raw source windows preserve cross-chunk UTF-8, CRLF and final unterminated lines', async () => {
  const file = join(root, 'boundary.txt');
  await fs.writeFile(file, `${'x\n'.repeat(32767)}한글\r\nlast`);
  const result = await readSourceWindows(file, [{ start: 32768, end: 32770 }]);
  assert.deepEqual(
    [...result],
    [
      [32768, '한글'],
      [32769, 'last'],
    ]
  );
});

test('adaptive source windows preserve split UTF-8 and CRLF across separated intervals', async () => {
  const file = join(root, 'adaptive-boundary.txt');
  // Seeking reads 64 KiB, then 128 KiB: split a codepoint at that seam.
  const prefix = `${'x'.repeat(192 * 1024 - 2)}\n`;
  const gap = 'skip\n'.repeat(300000);
  await fs.writeFile(file, `${prefix}한글\r\n${gap}last`);
  const result = await readSourceWindows(file, [{ start: 2, end: 2 }, { start: 300003, end: 300003 }]);
  assert.deepEqual([...result], [[2, '한글'], [300003, 'last']]);
});

test('nearby source windows keep a single 64 KiB read on a large file', async (t) => {
  const file = join(root, 'nearby-window.txt');
  await fs.writeFile(file, 'line\n'.repeat(100000));
  const open = fs.open;
  const reads = [];
  mockFs(t, 'open', async (...args) => {
    const handle = await open(...args);
    if (args[0] === file) {
      const read = handle.read.bind(handle);
      handle.read = async (...a) => {
        reads.push(a[2]);
        return read(...a);
      };
    }
    return handle;
  });
  assert.deepEqual([...(await readSourceWindows(file, [{ start: 2, end: 3 }]))], [[2, 'line'], [3, 'line']]);
  assert.deepEqual(reads, [65536]);
});

test('deep raw windows rescan large files and detect same-version suffix newline changes', async (t) => {
  const file = join(root, 'deep.txt');
  const rows = Array.from({ length: 30000 }, (_, i) => `row${i} ${'x'.repeat(240)}`);
  const original = `${rows.join('\n')}\n`;
  await fs.writeFile(file, original);
  const time = new Date('2025-01-01T00:00:00.000Z');
  await fs.utimes(file, time, time);
  const st = await fs.stat(file);
  await readSourceWindows(file, [{ start: 29980, end: 29981 }]);
  const open = fs.open;
  let bytes = 0;
  mockFs(t, 'open', async (...args) => {
    const handle = await open(...args);
    if (args[0] === file) {
      const stat = handle.stat.bind(handle);
      handle.stat = async (...args) => {
        const observed = await stat(...args);
        observed.ctimeMs = st.ctimeMs;
        return observed;
      };
      const read = handle.read.bind(handle);
      handle.read = async (...a) => {
        const result = await read(...a);
        bytes += result.bytesRead;
        return result;
      };
    }
    return handle;
  });
  const stat = fs.stat;
  mockFs(t, 'stat', async (path, ...args) => {
    const observed = await stat(path, ...args);
    if (path === file) observed.ctimeMs = st.ctimeMs;
    return observed;
  });
  const repeated = await readSourceWindows(file, [{ start: 29980, end: 29981 }]);
  assert.equal(repeated.get(29980), rows[29979]);
  // This near-EOF window needs the final chunk: fresh coordinate
  // validation scans the file once rather than trusting a cached deep anchor.
  assert.equal(bytes, st.size);
  const newline = original.indexOf('\n', 65536);
  const replacement = `${original.slice(0, newline)} ${original.slice(newline + 1)}`;
  assert.equal(Buffer.byteLength(replacement), st.size);
  assert.deepEqual(Buffer.from(replacement).subarray(0, 65536), Buffer.from(original).subarray(0, 65536));
  await fs.writeFile(file, replacement);
  await fs.utimes(file, time, time);
  const observed = await fs.stat(file);
  for (const key of ['mtimeMs', 'ctimeMs', 'size', 'ino', 'dev']) assert.equal(observed[key], st[key]);
  const changed = await readSourceWindows(file, [{ start: 29980, end: 29981 }]);
  assert.equal(changed.get(29980), rows[29980]);
  assert.equal(changed.get(29981), rows[29981]);
});

test('combined pattern context reads each selected file once', async (t) => {
  const file = join(root, 'combined.txt');
  await fs.writeFile(file, 'before\nalpha\nmiddle\nbeta\nafter\n');
  const open = fs.open;
  let opens = 0;
  mockFs(t, 'open', async (...args) => {
    if (args[0] === file) opens++;
    return open(...args);
  });
  const result = await runGrepPatternFanout(
    fanoutOptions({
      contextN: 2,
      options: {
        __runRgWindowedLines: async () => ({
          lines: ['combined.txt:2:alpha', 'combined.txt:4:beta'],
          complete: true,
          partial: false,
        }),
      },
    })
  );
  assert.match(result, /# grep pattern:"alpha"/);
  assert.match(result, /# grep pattern:"beta"/);
  // An explicit context is honoured exactly: each pattern renders its own
  // +-2 window rather than being widened to the automatic one.
  assert.match(result, /# combined\.txt:2 \[lines 1-4\]\nbefore\nalpha\nmiddle\nbeta/);
  assert.match(result, /# combined\.txt:4 \[lines 2-5\]\nalpha\nmiddle\nbeta\nafter/);
  assert.equal(opens, 1);
});

test('broad context expansion bounds simultaneously open files', async (t) => {
  const lines = [];
  for (let i = 0; i < 20; i++) {
    await fs.writeFile(join(root, `source-${i}.txt`), 'needle\n');
    lines.push(`source-${i}.txt:1:needle`);
  }
  const open = fs.open;
  let active = 0;
  let peak = 0;
  mockFs(t, 'open', async (...args) => {
    const handle = await open(...args);
    if (String(args[0]).includes('source-')) {
      peak = Math.max(peak, ++active);
      const close = handle.close.bind(handle);
      handle.close = async () => {
        try {
          await close();
        } finally {
          active--;
        }
      };
      await nextTurn();
    }
    return handle;
  });
  const sources = await prepareGrepContextSources([lines], contextOptions({ headLimit: 30 }));
  assert.equal(sources.size, 20);
  assert.ok([...sources.values()].every((entry) => entry.lines.get(1) === 'needle'));
  assert.ok(peak <= 4, `opened ${peak} files concurrently`);
  assert.equal(active, 0);
});

test('one-sided context is preserved by independent pattern searches', async () => {
  const result = await runGrepPatternFanout(
    fanoutOptions({
      args: { '-A': 2 },
      afterN: 2,
      options: {
        __runRgWindowedLines: async () => ({
          lines: ['combined.txt'],
          complete: true,
          partial: false,
        }),
      },
      executeGrepTool: async (args) => (args['-A'] === 2 ? `${args.pattern}\nfollowing context` : ''),
    })
  );
  assert.match(result, /alpha\nfollowing context/);
  assert.match(result, /beta\nfollowing context/);
});

test('cancelled combined searches never start a prefilter or pattern fallback', async () => {
  const controller = new AbortController();
  let scans = 0;
  await assert.rejects(
    runGrepPatternFanout(
      fanoutOptions({
        options: {
          signal: controller.signal,
          __runRgWindowedLines: async () => {
            scans++;
            controller.abort(new Error('cancelled by caller'));
            throw controller.signal.reason;
          },
        },
      })
    ),
    /cancelled by caller/
  );
  assert.equal(scans, 1);
});

test('cancelled source context does not become a successful anchor-only result', async () => {
  const controller = new AbortController();
  controller.abort(new Error('stop source read'));
  await assert.rejects(
    expandGrepAnchorContextOutput({
      ...contextOptions(),
      allLines: ['combined.txt:2:alpha'],
      signal: controller.signal,
    }),
    /stop source read/
  );
});

test('permission errors on relative scopes do not broaden the search to the project', async (t) => {
  const denied = join(root, 'denied');
  const stat = fs.stat;
  mockFs(t, 'stat', async (path, ...args) => {
    if (String(path).toLowerCase() === denied.toLowerCase()) {
      throw Object.assign(new Error('denied'), { code: 'EACCES' });
    }
    return stat(path, ...args);
  });
  const out = await executeGrepTool({ path: 'denied', pattern: 'alpha' }, root, async () => '', null);
  assert.match(out, /EACCES/);
  assert.doesNotMatch(out, /searched the project root/);
});

test('full read tool reuses one handle and sample across range classification and reading', async (t) => {
  const file = join(root, 'read-once.txt');
  await fs.writeFile(file, 'hello\n'.repeat(40000));
  const open = fs.open;
  let opens = 0;
  let bytes = 0;
  mockFs(t, 'open', async (...args) => {
    const handle = await open(...args);
    if (args[0] === file) {
      opens++;
      const read = handle.read.bind(handle);
      handle.read = async (...a) => {
        const result = await read(...a);
        bytes += result.bytesRead;
        return result;
      };
    }
    return handle;
  });
  const out = await executeBuiltinTool('read', { path: file, offset: 0, limit: 5 }, root);
  assert.match(readRowsForDisplay(String(out)), /1→hello/);
  assert.equal(opens, 1);
  assert.ok(bytes <= 68 * 1024, `range classification read ${bytes} bytes`);
});

test('shared classification retains UTF-16 byte order and binary tail detection', async () => {
  for (const encoding of ['le', 'be']) {
    const file = join(root, `utf16-${encoding}.txt`);
    const text = Buffer.from('한글\n'.repeat(30000), 'utf16le');
    await fs.writeFile(
      file,
      Buffer.concat([
        Buffer.from(encoding === 'le' ? [255, 254] : [254, 255]),
        encoding === 'le' ? text : text.swap16(),
      ])
    );
    const out = await executeBuiltinTool('read', { path: file, offset: 0, limit: 2 }, root);
    assert.match(readRowsForDisplay(String(out)), /1→한글\n2→한글/);
  }
  const file = join(root, 'binary-tail.bin');
  await fs.writeFile(file, Buffer.concat([Buffer.alloc(200000, 65), Buffer.from([0])]));
  const out = await executeBuiltinTool('read', { path: file, offset: 0, limit: 2 }, root);
  assert.match(String(out), /binary, 200001 bytes/);
});
