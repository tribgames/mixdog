import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

// The data dir is relocated before the import so any incidental provider-module
// path resolution can only land in a unique temp directory, never in the
// operator's data dir.
const dataDir = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'mixdog-openai-prewarm-')));
const previousDataDir = process.env.MIXDOG_DATA_DIR;
process.env.MIXDOG_DATA_DIR = dataDir;

const { retireStartupPrewarmRecord } = await import('./openai-startup-prewarm.mjs');
const { OpenAIOAuthProvider } = await import('./openai-oauth.mjs');

test.after(() => {
  if (previousDataDir === undefined) delete process.env.MIXDOG_DATA_DIR;
  else process.env.MIXDOG_DATA_DIR = previousDataDir;
  rmSync(dataDir, { recursive: true, force: true });
});

function prewarmProvider() {
  const provider = new OpenAIOAuthProvider({});
  provider.ensureAuth = async () => ({ access_token: 'test-token' });
  return provider;
}

test('an in-flight prewarm record is retired only while it is still the current one', () => {
  const inFlight = new Map();
  const first = { task: Promise.resolve(true) };
  const second = { task: Promise.resolve(true) };
  inFlight.set('s1', first);

  inFlight.set('s1', second);
  retireStartupPrewarmRecord(inFlight, 's1', first);
  assert.equal(inFlight.get('s1'), second, 'a settled prewarm must not evict its successor');

  retireStartupPrewarmRecord(inFlight, 's1', second);
  assert.equal(inFlight.size, 0);
});

test('connection prewarm acquires a socket and returns it to the pool', async () => {
  const provider = prewarmProvider();
  const entry = {};
  const released = [];
  const ready = await provider.prewarmWsTransportForSession(
    { sessionId: 'conn-1', model: 'gpt-5.6-sol' },
    {
      _hasPooled: () => false,
      _warmVersion: async () => {},
      _acquire: async () => ({ entry, reused: false }),
      _release: (args) => released.push(args),
    }
  );
  assert.equal(ready, true);
  assert.equal(released.length, 1);
  assert.equal(released[0].entry, entry);
  assert.equal(released[0].poolKey, 'conn-1');
  assert.equal(released[0].keep, true);
  assert.equal(provider._startupPrewarmByPoolKey.size, 0, 'the in-flight record is retired');
});

test('connection prewarm skips acquiring when the session already has a pooled socket', async () => {
  const provider = prewarmProvider();
  let acquires = 0;
  const ready = await provider.prewarmWsTransportForSession(
    { sessionId: 'conn-2' },
    {
      _hasPooled: () => true,
      _warmVersion: async () => {},
      _acquire: async () => {
        acquires += 1;
        return { entry: {} };
      },
      _release: () => {},
    }
  );
  assert.equal(ready, true);
  assert.equal(acquires, 0);
});

test('concurrent prewarms for one session share a single in-flight acquire', async () => {
  const provider = prewarmProvider();
  let acquires = 0;
  let openGate;
  const gate = new Promise((resolve) => {
    openGate = resolve;
  });
  const seams = {
    _hasPooled: () => false,
    _warmVersion: async () => {},
    _acquire: async () => {
      acquires += 1;
      await gate;
      return { entry: {}, reused: false };
    },
    _release: () => {},
  };
  const first = provider.prewarmWsTransportForSession({ sessionId: 'conn-3' }, seams);
  const second = provider.prewarmWsTransportForSession({ sessionId: 'conn-3' }, seams);
  openGate();
  assert.deepEqual(await Promise.all([first, second]), [true, true]);
  assert.equal(acquires, 1);
});

test('a prewarm without a pool key, or with HTTP forced, never acquires a socket', async () => {
  const provider = prewarmProvider();
  let acquires = 0;
  const seams = {
    _hasPooled: () => false,
    _warmVersion: async () => {},
    _acquire: async () => {
      acquires += 1;
      return { entry: {} };
    },
    _release: () => {},
  };
  assert.equal(await provider.prewarmWsTransportForSession({}, seams), false);

  const previous = process.env.MIXDOG_OPENAI_OAUTH_FORCE_HTTP_FALLBACK;
  process.env.MIXDOG_OPENAI_OAUTH_FORCE_HTTP_FALLBACK = '1';
  try {
    assert.equal(await provider.prewarmWsTransportForSession({ sessionId: 'conn-4' }, seams), false);
  } finally {
    if (previous === undefined) delete process.env.MIXDOG_OPENAI_OAUTH_FORCE_HTTP_FALLBACK;
    else process.env.MIXDOG_OPENAI_OAUTH_FORCE_HTTP_FALLBACK = previous;
  }
  assert.equal(acquires, 0);
});
