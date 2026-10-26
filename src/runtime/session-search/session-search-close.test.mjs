// Run with --experimental-test-module-mocks.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { mock } from 'node:test';

// The install's own log lines are the events this test waits on: a retry
// scheduled, an install started, an install cancelled.
const logLines = [];
const logWaiters = [];
mock.module('../memory/lib/memory-log.mjs', {
  namedExports: {
    __mixdogMemoryLog: (...args) => {
      const line = args.join('');
      logLines.push(line);
      for (const waiter of [...logWaiters]) {
        if (!waiter.pattern.test(line)) continue;
        logWaiters.splice(logWaiters.indexOf(waiter), 1);
        waiter.resolve();
      }
    },
  },
});
const nextLog = (pattern) => new Promise((resolve) => logWaiters.push({ pattern, resolve }));
const logged = (pattern) => logLines.filter((line) => pattern.test(line)).length;
const RETRY = /download attempt 1 failed/;
const STARTED = /downloading runtime/;
const CANCELLED = /install of .* cancelled/;

const root = mkdtempSync(join(tmpdir(), 'mixdog-session-search-close-'));
const dataDir = join(root, 'data');
const previous = { data: process.env.MIXDOG_DATA_DIR, runtime: process.env.MIXDOG_RUNTIME_ROOT };
process.env.MIXDOG_DATA_DIR = dataDir;
process.env.MIXDOG_RUNTIME_ROOT = join(root, 'runtime-root');
const { closeSessionSearch, ingestSessionTurn } = await import('./session-search-ingest.mjs');

test.after(() => {
  for (const [key, value] of [
    ['MIXDOG_DATA_DIR', previous.data],
    ['MIXDOG_RUNTIME_ROOT', previous.runtime],
  ]) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(root, { recursive: true, force: true });
});

const runtimeDir = join(dataDir, 'runtime');

// Every data-dir entry outside the runtime dir, with its size and mtime: any
// write there changes it.
function snapshotOutsideRuntime() {
  const out = [];
  const walk = (path) => {
    for (const name of readdirSync(path)) {
      const child = join(path, name);
      if (child === runtimeDir) continue;
      const st = statSync(child);
      out.push(`${child} ${st.size} ${st.mtimeMs}`);
      if (st.isDirectory()) walk(child);
    }
  };
  if (existsSync(dataDir)) walk(dataDir);
  return out.sort();
}

const stagingEntries = () =>
  existsSync(runtimeDir) ? readdirSync(runtimeDir).filter((name) => name.startsWith('staging-')) : [];

const turn = (count) => ({
  id: 'sess_search_close',
  messages: Array.from({ length: count }, (_, index) => ({
    role: index % 2 ? 'assistant' : 'user',
    content: `message ${index}`,
  })),
});

test('closing a session cancels its PostgreSQL runtime install and its queued writes; nothing writes after the close', async (t) => {
  // Offline: every download attempt fails and the install waits out its retry backoff.
  const fetches = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    fetches.push(String(url));
    throw new Error('offline');
  });
  t.mock.timers.enable({ apis: ['setTimeout'] });

  const retrying = nextLog(RETRY);
  ingestSessionTurn(turn(1));
  // Queued behind the running write; the close must cancel them unstarted.
  ingestSessionTurn(turn(2));
  ingestSessionTurn(turn(3));
  await retrying;
  assert.equal(
    stagingEntries().filter((name) => name.endsWith('.lock')).length,
    1,
    'the install holds its staging lock'
  );

  await closeSessionSearch('sess_search_close');
  assert.equal(logged(CANCELLED), 1, 'the install was cancelled before the close resolved');
  assert.deepEqual(stagingEntries(), [], 'its staging lock is released and nothing is left staged');
  assert.equal(logged(STARTED), 1, 'the queued writes started no install');
  const closed = snapshotOutsideRuntime();
  // The whole 1/3/9 s retry schedule passes.
  t.mock.timers.tick(13_000);

  // A later write is not blocked by the cancelled install: it starts a fresh one.
  const restarted = nextLog(STARTED);
  ingestSessionTurn(turn(4));
  await restarted;
  assert.equal(logged(STARTED), 2);
  assert.equal(fetches.length, 2, 'the cancelled install never retried; the fresh one made its first attempt');
  assert.deepEqual(snapshotOutsideRuntime(), closed, 'nothing wrote into the data dir after the close');
  assert.equal(stagingEntries().length, 1, 'the runtime dir holds only the fresh install’s lock');

  await closeSessionSearch('sess_search_close');
  assert.equal(logged(CANCELLED), 2);
  assert.deepEqual(stagingEntries(), []);
});
