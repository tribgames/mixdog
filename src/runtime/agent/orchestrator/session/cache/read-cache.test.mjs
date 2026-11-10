import test from 'node:test';
import assert from 'node:assert/strict';
import fs, { mkdtempSync, readFileSync, rmSync, writeFileSync, statSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
import { READ_PREFIX_HASH_BYTES } from '../../tools/builtin/read-cache-policy.mjs';

const root = mkdtempSync(join(tmpdir(), 'mixdog-session-read-cache-'));
process.env.MIXDOG_DATA_DIR = join(root, 'data');
process.env.MIXDOG_AGENT_TRACE_DISABLE = '1';
// These read/cache tests never execute patches. Avoid an unrelated server
// holding its executable open when the Windows fixture is removed at exit.
process.env.MIXDOG_PATCH_NATIVE_PREWARM = '0';
const { captureReadCacheState, tryReadCached, setReadCached, invalidatePathForSession } = await import(
  './read-cache.mjs'
);
const { _statTuple, _statEqual, _normalizeCacheKey } = await import('./util.mjs');
const { differentFieldValue } = await import('../../tools/builtin/file-version-test-helpers.mjs');
const { TEXT_CACHE_MAX_BYTES } = await import('./text-cache-budget.mjs');
const { setScopedToolCached } = await import('./scoped-cache.mjs');
const { executeBuiltinTool } = await import('../../tools/builtin.mjs');
const { BUILTIN_TOOLS } = await import('../../tools/builtin/builtin-tools.mjs');
const { processToolBatch } = await import('../tool-batch.mjs');
const { readRowsForDisplay } = await import('../../../../shared/read-row-numbers.mjs');
const { createEagerDispatcher } = await import('../eager-dispatch.mjs');
// The read tools flush range indexes and read snapshots into the data dir from
// their own exit hooks. Registered after those modules loaded, this removal
// runs after every one of them.
process.once('exit', () => rmSync(root, { recursive: true, force: true }));

function fixture(text = 'LINE_1\nLINE_2\nLINE_3\nLINE_4\nLINE_5\n') {
  const cwd = mkdtempSync(join(root, 'case-'));
  const file = join(cwd, 'file.txt');
  writeFileSync(join(cwd, 'original.txt'), text);
  writeFileSync(file, text);
  return { cwd, file, sessionId: `cache-test-${randomUUID()}` };
}
function nextOffset(output) {
  const match = /offset:(\d+) for more/.exec(output);
  assert.ok(match, output);
  return Number(match[1]);
}
async function batch(fx, calls, executeToolFn, { eager = false, schemaAllowedTools = null } = {}) {
  const results = [];
  const sessionRef = { schemaAllowedTools };
  const crossTurnCalls = new Map();
  const dispatcher = createEagerDispatcher({
    tools: BUILTIN_TOOLS,
    cwd: fx.cwd,
    sessionId: fx.sessionId,
    sessionRef,
    signal: null,
    opts: {},
    crossTurnCalls,
    getIterations: () => 1,
    getNextIteration: () => 1,
    repeatFailLimit: 3,
    executeToolFn,
  });
  if (eager) {
    for (const call of calls) dispatcher.onToolCall(call);
    await Promise.all([...dispatcher.pending.values()].map((entry) => entry.promise));
  }
  await processToolBatch({
    calls,
    messages: [],
    tools: BUILTIN_TOOLS,
    cwd: fx.cwd,
    sessionId: fx.sessionId,
    sessionRef,
    signal: null,
    opts: {},
    iterations: 1,
    assistantTurnMsg: { role: 'assistant', content: '', toolCalls: calls },
    pending: dispatcher.pending,
    epoch: dispatcher.epoch,
    startEagerRun: eager ? dispatcher.startEagerRun : () => {},
    crossTurnCalls,
    crossTurnCap: 100,
    sessionAgent: null,
    pushToolResultMessage: (message) => results.push(message),
    throwIfAborted: () => {},
    repeatFailLimit: 3,
    dedupStubTotal: 0,
    editCount: 0,
    executeToolFn,
  });
  return results;
}
const readCall = (args) => ({ id: randomUUID(), name: 'read', arguments: args });
const executeRead = (fx) => (name, args, cwd) => executeBuiltinTool(name, args, cwd, { sessionId: fx.sessionId });

test('unchanged scalar reads retain exact cached content and source identity', async () => {
  const fx = fixture();
  const args = { file_path: fx.file, offset: 1, limit: 2 };
  const readState = captureReadCacheState({ args, cwd: fx.cwd });
  const content = String(await executeRead(fx)('read', args, fx.cwd));
  setReadCached({ ...fx, args, content, toolUseId: 'original', readState });
  assert.equal(tryReadCached({ ...fx, args })?.content, content);
  assert.equal(tryReadCached({ ...fx, args })?.firstToolUseId, 'original');
});

test('scalar and array read caches bypass oversized results without evicting other reads', () => {
  const fx = fixture();
  const keep = { file_path: fx.file, offset: 1, limit: 1 };
  setReadCached({ ...fx, args: keep, content: 'retained' });
  for (const args of [{ file_path: fx.file }, { file_path: [fx.file] }]) {
    setReadCached({ ...fx, args, content: 'x'.repeat(TEXT_CACHE_MAX_BYTES / 2) });
    assert.equal(tryReadCached({ ...fx, args }), null);
    assert.equal(tryReadCached({ ...fx, args: keep })?.content, 'retained');
  }
});

for (const firstPublic of [true, false]) {
  test(`cached continuation never skips or repeats a row across aliases (public first=${firstPublic})`, async () => {
    const fx = fixture();
    const publicArgs = { file_path: fx.file, offset: 1, limit: 2 };
    const legacyArgs = { path: fx.file, offset: 0, limit: 2 };
    const first = firstPublic ? publicArgs : legacyArgs;
    const second = firstPublic ? legacyArgs : publicArgs;
    const content = String(await executeRead(fx)('read', first, fx.cwd));
    setReadCached({ ...fx, args: first, content });
    const hit = tryReadCached({ ...fx, args: second });
    const output =
      hit?.content ??
      String(
        await executeBuiltinTool('read', second, fx.cwd, {
          sessionId: fx.sessionId,
          suppressReadUnchangedStub: true,
        })
      );
    const resume = String(
      await executeRead(fx)(
        'read',
        {
          ...second,
          offset: nextOffset(output),
        },
        fx.cwd
      )
    );
    assert.match(readRowsForDisplay(resume), /^3→LINE_3/);
  });
}

test('same-size same-mtime external rewrites invalidate session results when ctime changes', async (t) => {
  const fx = fixture('BEFORE\n');
  const time = new Date('2025-01-01T00:00:00.000Z');
  utimesSync(fx.file, time, time);
  const args = { file_path: fx.file };
  const content = String(await executeRead(fx)('read', args, fx.cwd));
  setReadCached({ ...fx, args, content });
  const before = statSync(fx.file);
  writeFileSync(fx.file, 'AFTER_\n');
  utimesSync(fx.file, time, time);
  const after = statSync(fx.file);
  assert.equal(before.size, after.size);
  assert.equal(before.mtimeMs, after.mtimeMs);
  // Keep real bytes/mtime, but make the observed version change independent
  // of the filesystem clock's resolution.
  const ctimeMs = differentFieldValue(before.ctimeMs, 'ctimeMs');
  const originalStat = fs.statSync;
  const mock = t.mock.method(fs, 'statSync', (path, ...options) => {
    const st = originalStat(path, ...options);
    if (_normalizeCacheKey(path) === _normalizeCacheKey(fx.file)) st.ctimeMs = ctimeMs;
    return st;
  });
  syncBuiltinESMExports();
  try {
    assert.notEqual(_statTuple(fx.file).ctimeMs, before.ctimeMs);
    assert.equal(tryReadCached({ ...fx, args }), null);
  } finally {
    mock.mock.restore();
    syncBuiltinESMExports();
  }
});

for (const publicInput of [false, true]) {
  for (const objects of [false, true]) {
    test(`array caching preserves windows and invalidates by constituent path (public=${publicInput}, objects=${objects})`, async () => {
      const fx = fixture();
      const other = join(fx.cwd, 'other.txt');
      writeFileSync(other, 'OTHER_1\nOTHER_2\n');
      const key = publicInput ? 'file_path' : 'path';
      const paths = [fx.file, other];
      const offset = publicInput ? 2 : 1;
      const args = objects
        ? { [key]: paths.map((path) => ({ [key]: path, offset, limit: 1 })) }
        : { [key]: paths, offset, limit: 1 };
      const readState = captureReadCacheState({ args, cwd: fx.cwd });
      const content = String(await executeRead(fx)('read', args, fx.cwd));
      assert.match(readRowsForDisplay(content), /2→LINE_2/);
      assert.match(readRowsForDisplay(content), /2→OTHER_2/);
      setReadCached({ ...fx, args, content, readState });
      assert.equal(tryReadCached({ ...fx, args })?.content, content);
      invalidatePathForSession(fx.sessionId, other, fx.cwd);
      assert.equal(tryReadCached({ ...fx, args }), null);
    });
  }
}

test('a changed array member or unavailable source version prevents deferred insertion', async () => {
  const fx = fixture();
  const other = join(fx.cwd, 'other.txt');
  writeFileSync(other, 'old\n');
  const args = { file_path: [fx.file, other] };
  const readState = captureReadCacheState({ args, cwd: fx.cwd });
  const content = String(await executeRead(fx)('read', args, fx.cwd));
  writeFileSync(other, 'changed\n');
  setReadCached({ ...fx, args, content, readState });
  assert.equal(tryReadCached({ ...fx, args }), null);
  setReadCached({ ...fx, args, content, readState: null });
  assert.equal(tryReadCached({ ...fx, args }), null);
});

for (const eager of [false, true]) {
  test(`deferred insertion never relabels an older read after an external write (eager=${eager})`, async () => {
    const fx = fixture('BEFORE\n');
    const args = { file_path: fx.file };
    const [first] = await batch(
      fx,
      [readCall(args)],
      async (name, input, cwd) => {
        const output = await executeRead(fx)(name, input, cwd);
        writeFileSync(fx.file, 'NEW_CONTENT\n');
        return output;
      },
      { eager }
    );
    assert.match(first.content, /BEFORE/);
    const [second] = await batch(fx, [readCall(args)], executeRead(fx), { eager });
    assert.match(second.content, /NEW_CONTENT/);
    assert.doesNotMatch(second.content, /BEFORE/);
    assert.equal(readFileSync(fx.file, 'utf8'), 'NEW_CONTENT\n');
  });

  test(`an unchanged read still becomes a reusable session result (eager=${eager})`, async () => {
    const fx = fixture();
    const args = { file_path: fx.file, offset: 2, limit: 1 };
    let executions = 0;
    const execute = async (...input) => {
      executions++;
      return executeRead(fx)(...input);
    };
    const [first] = await batch(fx, [readCall(args)], execute, { eager });
    const [second] = await batch(fx, [readCall(args)], execute, { eager });
    assert.equal(executions, 1);
    assert.equal(second.content, first.content);
    assert.equal(second.toolKind, 'cache-hit');
  });
}

for (const cached of [false, true]) {
  for (const name of ['read', 'grep']) {
    test(`schema denial precedes cache and execution (${name}, cached=${cached})`, async () => {
      const fx = fixture('CACHED_BODY\n');
      const args = name === 'read' ? { file_path: fx.file } : { path: fx.file, pattern: 'CACHED_BODY', context: 0 };
      if (cached) {
        const content = 'CACHED_BODY';
        if (name === 'read') setReadCached({ ...fx, args, content });
        else setScopedToolCached({ ...fx, toolName: name, args, content });
      }
      let executions = 0;
      const calls = [1, 2].map(() => ({ id: randomUUID(), name, arguments: args }));
      const results = await batch(
        fx,
        calls,
        async () => {
          executions++;
          return 'unexpected';
        },
        { eager: true, schemaAllowedTools: [] }
      );
      assert.equal(executions, 0);
      assert.equal(results.length, 2);
      for (const result of results) {
        assert.equal(result.toolKind, 'error');
        assert.match(result.content, /schema allowlist/);
        assert.doesNotMatch(result.content, /CACHED_BODY/);
      }
    });
  }
}

test('cache metadata probes do not touch UNC or device paths before read validation', (t) => {
  const paths = ['//blocked.invalid/share/file.txt', '\\\\blocked.invalid\\share\\file.txt', '/dev/zero'];
  if (process.platform === 'win32') paths.push('NUL', 'C:/temp/file.txt:stream');
  let stats = 0;
  t.mock.method(fs, 'statSync', () => {
    stats++;
    throw new Error('unexpected filesystem access');
  });
  syncBuiltinESMExports();
  try {
    for (const path of paths) assert.equal(_statTuple(path), null);
    assert.equal(stats, 0);
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
});

const FIXED_TIME = new Date('2025-01-01T00:00:00.000Z');
const PREFIX_LINE = `${'A'.repeat(63)}\n`;
const SUFFIX_LINE = READ_PREFIX_HASH_BYTES / PREFIX_LINE.length + 1;
const ALIASES = ['file_path', 'path', 'file_path[]', 'path[]', 'file_path objects', 'path objects'];

function largeLines(suffix) {
  return `${PREFIX_LINE.repeat(SUFFIX_LINE - 1)}${suffix}\n`;
}
function aliasArgs(shape, file, window = null) {
  const ranged = window ? { offset: window.offset, limit: window.limit } : {};
  if (shape === 'file_path') return { file_path: file, ...ranged };
  if (shape === 'path') return { path: file, ...ranged };
  if (shape === 'file_path[]') return { file_path: [file], ...ranged };
  if (shape === 'path[]') return { path: [file], ...ranged };
  if (shape === 'file_path objects') return { file_path: [{ file_path: file, ...ranged }] };
  if (shape === 'path objects') return { path: [{ path: file, ...ranged }] };
  throw new Error(shape);
}
function suffixArgs(shape, file) {
  const offset = shape.startsWith('path') ? SUFFIX_LINE - 1 : SUFFIX_LINE;
  return aliasArgs(shape, file, { offset, limit: 1 });
}
function statSnapshot(file) {
  const st = statSync(file);
  return {
    mtimeMs: st.mtimeMs,
    ctimeMs: st.ctimeMs,
    size: st.size,
    ino: typeof st.ino === 'number' ? st.ino : Number(st.ino) || 0,
    dev: typeof st.dev === 'number' ? st.dev : Number(st.dev) || 0,
  };
}
function pinCtime(t, file, ctimeMs) {
  const key = _normalizeCacheKey(file);
  const original = fs.statSync;
  const mock = t.mock.method(fs, 'statSync', (path, ...options) => {
    const st = original(path, ...options);
    if (_normalizeCacheKey(path) === key) st.ctimeMs = ctimeMs;
    return st;
  });
  syncBuiltinESMExports();
  return () => {
    mock.mock.restore();
    syncBuiltinESMExports();
  };
}

test('prefix-budget boundary stays cached across scalar and array aliases', () => {
  const fx = fixture();
  const exact = join(fx.cwd, 'exact.txt');
  const exactOther = join(fx.cwd, 'exact-other.txt');
  const over = join(fx.cwd, 'over.txt');
  writeFileSync(exact, 'x'.repeat(READ_PREFIX_HASH_BYTES));
  writeFileSync(exactOther, 'z'.repeat(READ_PREFIX_HASH_BYTES));
  writeFileSync(over, 'y'.repeat(READ_PREFIX_HASH_BYTES + 1));
  assert.equal(statSync(exact).size, READ_PREFIX_HASH_BYTES);
  assert.equal(statSync(over).size, READ_PREFIX_HASH_BYTES + 1);
  for (const shape of ALIASES) {
    const exactArgs = aliasArgs(shape, exact);
    const state = captureReadCacheState({ args: exactArgs, cwd: fx.cwd });
    assert.ok(state, shape);
    setReadCached({ ...fx, args: exactArgs, content: `exact:${shape}`, readState: state });
    assert.equal(tryReadCached({ ...fx, args: exactArgs })?.content, `exact:${shape}`, shape);
    const overArgs = aliasArgs(shape, over);
    assert.equal(captureReadCacheState({ args: overArgs, cwd: fx.cwd }), null, shape);
    setReadCached({ ...fx, args: overArgs, content: `over:${shape}` });
    setReadCached({ ...fx, args: overArgs, content: `over:${shape}`, readState: null });
    assert.equal(tryReadCached({ ...fx, args: overArgs }), null, shape);
  }
  const both = { file_path: [exact, exactOther] };
  const bothState = captureReadCacheState({ args: both, cwd: fx.cwd });
  assert.ok(bothState);
  setReadCached({ ...fx, args: both, content: 'both-exact', readState: bothState });
  assert.equal(tryReadCached({ ...fx, args: both })?.content, 'both-exact');
  const mixedBoundary = { path: [exact, over] };
  assert.equal(captureReadCacheState({ args: mixedBoundary, cwd: fx.cwd }), null);
  setReadCached({ ...fx, args: mixedBoundary, content: 'mixed-boundary' });
  assert.equal(tryReadCached({ ...fx, args: mixedBoundary }), null);
  assert.equal(tryReadCached({ ...fx, args: both })?.content, 'both-exact');
});

test('prefix-budget mixed arrays stay uncached and preserve unrelated small entries', () => {
  const fx = fixture('SMALL\n');
  const other = join(fx.cwd, 'other.txt');
  const large = join(fx.cwd, 'large.txt');
  writeFileSync(other, 'OTHER\n');
  writeFileSync(large, 'L'.repeat(READ_PREFIX_HASH_BYTES + 1));
  const scalar = { file_path: fx.file, offset: 1, limit: 1 };
  const smallArray = { path: [other] };
  setReadCached({ ...fx, args: scalar, content: 'kept-scalar' });
  setReadCached({ ...fx, args: smallArray, content: 'kept-array' });
  for (const args of [
    { file_path: [fx.file, large] },
    { path: [large, other] },
    { file_path: [{ file_path: fx.file }, { path: large }] },
    { path: [{ path: other }, { file_path: large }] },
  ]) {
    assert.equal(captureReadCacheState({ args, cwd: fx.cwd }), null);
    setReadCached({ ...fx, args, content: 'mixed-body' });
    assert.equal(tryReadCached({ ...fx, args }), null);
  }
  assert.equal(tryReadCached({ ...fx, args: scalar })?.content, 'kept-scalar');
  assert.equal(tryReadCached({ ...fx, args: smallArray })?.content, 'kept-array');
  invalidatePathForSession(fx.sessionId, large, fx.cwd);
  assert.equal(tryReadCached({ ...fx, args: scalar })?.content, 'kept-scalar');
  assert.equal(tryReadCached({ ...fx, args: smallArray })?.content, 'kept-array');
  invalidatePathForSession(fx.sessionId, fx.file, fx.cwd);
  assert.equal(tryReadCached({ ...fx, args: scalar }), null);
  assert.equal(tryReadCached({ ...fx, args: smallArray })?.content, 'kept-array');
});

for (const shape of ALIASES) {
  test(`prefix-budget same-metadata suffix rewrite is not reused (${shape})`, async (t) => {
    const fx = fixture(largeLines('OLD_SUFFIX'));
    utimesSync(fx.file, FIXED_TIME, FIXED_TIME);
    const args = aliasArgs(shape, fx.file);
    const before = statSnapshot(fx.file);
    assert.ok(before.size > READ_PREFIX_HASH_BYTES);
    setReadCached({ ...fx, args, content: 'STALE_OLD_SUFFIX' });
    writeFileSync(fx.file, largeLines('NEW_SUFFIX'));
    utimesSync(fx.file, FIXED_TIME, FIXED_TIME);
    const restore = pinCtime(t, fx.file, before.ctimeMs);
    try {
      assert.equal(_statEqual(_statTuple(fx.file), before), true, shape);
      assert.equal(tryReadCached({ ...fx, args }), null, shape);
    } finally {
      restore();
    }
  });
}

for (const eager of [false, true]) {
  test(`prefix-budget exact file still dedups across dispatch (eager=${eager})`, async () => {
    const fx = fixture('x\n'.repeat(READ_PREFIX_HASH_BYTES / 2));
    assert.equal(statSync(fx.file).size, READ_PREFIX_HASH_BYTES);
    const args = { file_path: fx.file, offset: 1, limit: 1 };
    let executions = 0;
    const execute = async (...input) => {
      executions += 1;
      return executeRead(fx)(...input);
    };
    const [first] = await batch(fx, [readCall(args)], execute, { eager });
    const [second] = await batch(fx, [readCall(args)], execute, { eager });
    assert.equal(executions, 1);
    assert.equal(second.content, first.content);
    assert.equal(second.toolKind, 'cache-hit');
  });

  for (const shape of ['file_path', 'path', 'file_path[]', 'path[]']) {
    test(`prefix-budget suffix rewrite re-executes on dispatch (${shape}, eager=${eager})`, async (t) => {
      const fx = fixture(largeLines('OLD_SUFFIX'));
      utimesSync(fx.file, FIXED_TIME, FIXED_TIME);
      const before = statSnapshot(fx.file);
      assert.ok(before.size > READ_PREFIX_HASH_BYTES);
      const args = suffixArgs(shape, fx.file);
      let executions = 0;
      const execute = async (...input) => {
        executions += 1;
        return executeRead(fx)(...input);
      };
      const [first] = await batch(fx, [readCall(args)], execute, { eager });
      assert.match(String(first.content), /OLD_SUFFIX/, shape);
      writeFileSync(fx.file, largeLines('NEW_SUFFIX'));
      utimesSync(fx.file, FIXED_TIME, FIXED_TIME);
      const restore = pinCtime(t, fx.file, before.ctimeMs);
      try {
        assert.equal(_statEqual(_statTuple(fx.file), before), true, shape);
        const [second] = await batch(fx, [readCall(args)], execute, { eager });
        assert.match(String(second.content), /NEW_SUFFIX/, shape);
        assert.doesNotMatch(String(second.content), /OLD_SUFFIX/, shape);
        assert.equal(executions, 2, shape);
        assert.equal(second.toolKind, 'normal', shape);
      } finally {
        restore();
      }
    });
  }
}
