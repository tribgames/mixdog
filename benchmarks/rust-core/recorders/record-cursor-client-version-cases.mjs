#!/usr/bin/env node
// Recording of providers/cursor-client-version.test.mjs (b6f10295a): the Cursor client version read from the installer script,
// the floor, the failure fallbacks, the MIXDOG_CURSOR_CLIENT_VERSION override and the MIXDOG_DISABLE_LIVE_CLI_VERSIONS kill
// switch. Each case gets a fresh module instance, an empty data dir and a scripted `fetch` (what the case scripts is recorded
// with the case: `answer`, `env`, `warms`); the recording holds the version presented and the URLs fetched.
//
//   node benchmarks/rust-core/recorders/record-cursor-client-version-cases.mjs --tree <export of b6f10295a with node_modules>
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { openSet } from './lib/case-set.mjs';
import { REPLAY_TARGETS } from './lib/replay-targets.mjs';

REPLAY_TARGETS['cursor-client-version-cases'] = {
  rust: [{ path: 'native/core/crates/mixdog-ai/src/client_versions.rs', line: 511, name: 'ClientVersions', methods: 'warm (client_versions.rs:608), cursor (client_versions.rs:592)' }],
};
const set = openSet('cursor-client-version-cases', import.meta.url);
const ENV_KEYS = ['MIXDOG_CURSOR_CLIENT_VERSION', 'MIXDOG_DISABLE_LIVE_CLI_VERSIONS'];
const MODULE = join(set.tree, 'src/runtime/agent/orchestrator/providers/cursor-client-version.mjs');
const realFetch = globalThis.fetch;
const roots = [];
let nonce = 0;

// Dated after any shipped floor, which every release raises.
const INSTALL = 'DOWNLOAD_URL="https://downloads.cursor.com/lab/2099.09.28-64d2043/${OS}/${ARCH}/agent-cli-package.tar.gz"';
const OLD_INSTALL = 'DOWNLOAD_URL="https://downloads.cursor.com/lab/2020.01.01-aaaaaaa/${OS}/${ARCH}/agent-cli-package.tar.gz"';

/** One fresh module instance with `answer` scripted as the installer fetch and `env` set; `warms` runs per the case. */
async function run({ answer, env = {}, warms }) {
  for (const k of ENV_KEYS) delete process.env[k];
  const dir = mkdtempSync(join(tmpdir(), 'client-version-'));
  roots.push(dir);
  process.env.MIXDOG_DATA_DIR = dir;
  Object.assign(process.env, env);
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    if (answer.throws) throw new Error(answer.throws);
    return { ok: answer.status === undefined, status: answer.status, text: async () => answer.body };
  };
  try {
    const mod = await import(`${pathToFileURL(MODULE).href}?n=${++nonce}`);
    for (const concurrent of warms) await Promise.all(Array.from({ length: concurrent }, () => mod.warmCursorClientVersion()));
    return { version: mod.cursorClientVersion(), floor: mod.CURSOR_CLIENT_VERSION_FLOOR, calls };
  } finally {
    globalThis.fetch = realFetch;
    for (const k of ENV_KEYS) delete process.env[k];
  }
}
const body = (text) => ({ body: text });
const scenario = (name, input) => set.run(name, () => run(input), { input });

await scenario('build id parsed from the installer script, fetched once', { answer: body(INSTALL), warms: [2, 1] });
await scenario('a build dated before the floor never replaces it', { answer: body(OLD_INSTALL), warms: [1] });
await scenario('format change falls back to the floor', { answer: body('#!/bin/sh\necho new installer layout'), warms: [1] });
await scenario('fetch failure and HTTP errors fall back to the floor', { answer: { throws: 'offline' }, warms: [1] });
await scenario('fetch failure and HTTP errors fall back to the floor (HTTP 503)', { answer: { status: 503, body: INSTALL }, warms: [1] });
await scenario('env override wins and skips the fetch', { answer: body(INSTALL), env: { MIXDOG_CURSOR_CLIENT_VERSION: 'cli-custom' }, warms: [1] });
await scenario('MIXDOG_DISABLE_LIVE_CLI_VERSIONS skips the fetch', { answer: body(INSTALL), env: { MIXDOG_DISABLE_LIVE_CLI_VERSIONS: '1' }, warms: [1] });

await set.finish({
  entry: { runs: 'cursor-client-version.mjs (warmCursorClientVersion, cursorClientVersion, CURSOR_CLIENT_VERSION_FLOOR), one fresh module instance per case over a scripted globalThis.fetch', notRun: 'no network, the operator\'s data dir is never touched' },
  replay: { entry: 'mixdog-ai client_versions.rs ClientVersions::warm(Dialect::Cursor) and ::cursor(): script the recorded answer as the installer fetch, set the recorded env, compare the version presented and the URLs fetched', normalised: {} },
});
for (const r of roots) rmSync(r, { recursive: true, force: true });
process.exit(0);
