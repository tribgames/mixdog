import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const realFetch = globalThis.fetch;
const ENV_KEYS = ['MIXDOG_CURSOR_CLIENT_VERSION', 'MIXDOG_DISABLE_LIVE_CLI_VERSIONS'];
let nonce = 0;

async function fresh(fetchImpl, env = {}) {
  for (const k of ENV_KEYS) delete process.env[k];
  // Each case starts with no remembered version and never touches the operator's.
  process.env.MIXDOG_DATA_DIR = mkdtempSync(join(tmpdir(), 'mixdog-client-version-'));
  Object.assign(process.env, env);
  const calls = [];
  globalThis.fetch = async (url, opts) => {
    calls.push(String(url));
    return fetchImpl(url, opts);
  };
  return { mod: await import(`./cursor-client-version.mjs?n=${++nonce}`), calls };
}

const script = (body) => async () => ({ ok: true, text: async () => body });
// Dated after any shipped floor, which every release raises.
const INSTALL =
  'DOWNLOAD_URL="https://downloads.cursor.com/lab/2099.09.28-64d2043/${OS}/${ARCH}/agent-cli-package.tar.gz"';
const OLD_INSTALL =
  'DOWNLOAD_URL="https://downloads.cursor.com/lab/2020.01.01-aaaaaaa/${OS}/${ARCH}/agent-cli-package.tar.gz"';

test.afterEach(() => {
  globalThis.fetch = realFetch;
  for (const k of ENV_KEYS) delete process.env[k];
});

test('build id parsed from the installer script, fetched once', async () => {
  const { mod, calls } = await fresh(script(INSTALL));
  await Promise.all([mod.warmCursorClientVersion(), mod.warmCursorClientVersion()]);
  await mod.warmCursorClientVersion();
  assert.equal(mod.cursorClientVersion(), 'cli-2099.09.28-64d2043');
  assert.deepEqual(calls, ['https://cursor.com/install']);
});

test('a build dated before the floor never replaces it', async () => {
  const { mod } = await fresh(script(OLD_INSTALL));
  await mod.warmCursorClientVersion();
  assert.equal(mod.cursorClientVersion(), mod.CURSOR_CLIENT_VERSION_FLOOR);
});

test('format change falls back to the floor', async () => {
  const { mod } = await fresh(script('#!/bin/sh\necho new installer layout'));
  await mod.warmCursorClientVersion();
  assert.equal(mod.cursorClientVersion(), mod.CURSOR_CLIENT_VERSION_FLOOR);
});

test('fetch failure and HTTP errors fall back to the floor', async () => {
  const failing = await fresh(async () => {
    throw new Error('offline');
  });
  await failing.mod.warmCursorClientVersion();
  assert.equal(failing.mod.cursorClientVersion(), failing.mod.CURSOR_CLIENT_VERSION_FLOOR);
  const http = await fresh(async () => ({ ok: false, status: 503, text: async () => INSTALL }));
  await http.mod.warmCursorClientVersion();
  assert.equal(http.mod.cursorClientVersion(), http.mod.CURSOR_CLIENT_VERSION_FLOOR);
});

test('env override wins and skips the fetch', async () => {
  const { mod, calls } = await fresh(script(INSTALL), { MIXDOG_CURSOR_CLIENT_VERSION: 'cli-custom' });
  await mod.warmCursorClientVersion();
  assert.equal(mod.cursorClientVersion(), 'cli-custom');
  assert.equal(calls.length, 0);
});

test('MIXDOG_DISABLE_LIVE_CLI_VERSIONS skips the fetch', async () => {
  const { mod, calls } = await fresh(script(INSTALL), { MIXDOG_DISABLE_LIVE_CLI_VERSIONS: '1' });
  await mod.warmCursorClientVersion();
  assert.equal(mod.cursorClientVersion(), mod.CURSOR_CLIENT_VERSION_FLOOR);
  assert.equal(calls.length, 0);
});
