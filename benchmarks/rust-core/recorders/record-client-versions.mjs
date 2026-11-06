#!/usr/bin/env node
// Golden twin of the live client versions (codex-client-meta.mjs, grok-client-version.mjs,
// cursor-client-version.mjs, antigravity-oauth-tokens.mjs over npm-cli-version.mjs and
// client-version-store.mjs): Node's own modules driven through scripted fetches and a scripted
// clock. Each scenario is a list of steps (a warm, a 426 body to learn, a process restart); the
// recording holds what Node fetched and the version it then presents. Rust
// `client_versions::ClientVersions` must fetch the same URLs at the same times and present the
// same versions.
//
//   node benchmarks/rust-core/recorders/record-client-versions.mjs [--tree <dir>]
//
// Output: native/core/fixtures/client-versions/golden.json.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { FIXTURES_ROOT, commitStage, importFrom, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } from './lib/common.mjs';

const tree = resolveTree(parseArgs());
const finalDir = join(FIXTURES_ROOT, 'client-versions');
const stage = stageSet(finalDir);
const recorder = 'benchmarks/rust-core/recorders/record-client-versions.mjs';

const BASE = 1_800_000_000_000;
const M = 60_000;
const H = 60 * M;
const D = 24 * H;
const npm = (version) => ({ status: 200, body: JSON.stringify({ version }) });
const text = (body, status = 200) => ({ status, body });
const FAIL = { fail: true };
const cursorInstall = (build) => text(`DOWNLOAD_URL="https://downloads.cursor.com/lab/${build}/\${OS}/\${ARCH}/agent-cli-package.tar.gz"`);
const manifest = (version) => text(`version: ${version}\npath: Antigravity.dmg\n`);
const warm = (dialect, at, net = [], extra = {}) => ({ do: 'warm', dialect, at, net, ...extra });

const SCENARIOS = [
  { name: 'codex-day-cache', steps: [
    warm('codex', 0, [npm('0.170.0')]),
    warm('codex', H),
    warm('codex', D - M),
    warm('codex', D + M, [npm('0.171.2')]),
    warm('codex', D + 2 * M),
  ] },
  { name: 'codex-concurrent-warms-share-one-fetch', steps: [warm('codex', 0, [npm('0.170.0')], { concurrent: 3 })] },
  { name: 'codex-never-below-the-floor', steps: [warm('codex', 0, [npm('0.100.0')])] },
  { name: 'codex-failure-waits-ten-minutes', steps: [
    warm('codex', 0, [FAIL]),
    warm('codex', 5 * M),
    warm('codex', 11 * M, [npm('0.180.0')]),
  ] },
  { name: 'codex-stale-refresh-failure-keeps-the-value', steps: [
    warm('codex', 0, [npm('0.170.0')]),
    warm('codex', D + M, [FAIL]),
    warm('codex', D + 5 * M),
    warm('codex', D + 12 * M, [text('{}', 503)]),
  ] },
  { name: 'codex-unrecognised-answers-are-ignored', steps: [
    warm('codex', 0, [npm('latest')]),
    warm('codex', 11 * M, [text('{"version":"1.2"}')]),
    warm('codex', 22 * M, [text('not json')]),
    warm('codex', 33 * M, [text('{"version":"0.190.1"}', 404)]),
  ] },
  { name: 'codex-remembered-across-restart', steps: [
    warm('codex', 0, [npm('0.175.0')]),
    { do: 'restart', at: M },
    warm('codex', M, [FAIL]),
  ] },
  { name: 'codex-disabled', env: { MIXDOG_DISABLE_LIVE_CLI_VERSIONS: '1' }, steps: [
    warm('codex', 0, [npm('0.175.0')]),
    { do: 'restart', at: M },
    warm('codex', M, [npm('0.175.0')]),
  ] },
  { name: 'codex-pinned-version-header', env: { MIXDOG_CODEX_VERSION: ' 0.150.0 ' }, steps: [warm('codex', 0, [npm('0.175.0')])] },
  { name: 'grok-live-and-learned', steps: [
    warm('grok', 0, [npm('1.0.80')]),
    { do: 'learn', at: M, text: 'client outdated' },
    { do: 'learn', at: M, text: '426: minimum version 1.0.95 required' },
    { do: 'learn', at: M, text: 'minimum version 1.0.90' },
    { do: 'learn', at: M, text: 'Upgrade to 1.1.0 now' },
    { do: 'learn', at: M, text: 'at least 1.1.0' },
    { do: 'learn', at: M, text: null },
    warm('grok', D + 2 * M, [npm('1.0.82')]),
  ] },
  { name: 'grok-npm-below-the-floor', steps: [warm('grok', 0, [npm('0.9.0')])] },
  { name: 'grok-remembered-across-restart', steps: [
    warm('grok', 0, [npm('1.0.99')]),
    { do: 'restart', at: M },
    warm('grok', M, [FAIL]),
  ] },
  { name: 'grok-env-override', env: { MIXDOG_GROK_CLIENT_VERSION: ' 1.0.50 ' }, steps: [
    warm('grok', 0, [npm('1.0.99')]),
    { do: 'learn', at: M, text: 'minimum version 1.0.95' },
  ] },
  { name: 'cursor-build-from-the-installer', steps: [
    warm('cursor', 0, [cursorInstall('2099.09.28-64d2043')], { concurrent: 2 }),
    warm('cursor', H),
  ] },
  { name: 'cursor-older-build-never-replaces-the-floor', steps: [warm('cursor', 0, [cursorInstall('2020.01.01-aaaaaaa')])] },
  { name: 'cursor-format-change-and-failures', steps: [
    warm('cursor', 0, [text('#!/bin/sh\necho new installer layout')]),
    warm('cursor', 11 * M, [text('x', 503)]),
    warm('cursor', 22 * M, [FAIL]),
  ] },
  { name: 'cursor-env-override', env: { MIXDOG_CURSOR_CLIENT_VERSION: 'cli-custom' }, steps: [warm('cursor', 0, [cursorInstall('2099.09.28-64d2043')])] },
  { name: 'antigravity-once-per-process', steps: [
    warm('antigravity', 0, [manifest('2.25.0')]),
    warm('antigravity', 30 * D),
  ] },
  { name: 'antigravity-failure-holds-ten-minutes', steps: [
    warm('antigravity', 0, [FAIL]),
    warm('antigravity', 5 * M),
    warm('antigravity', 11 * M, [manifest('2.30.1')]),
  ] },
  { name: 'antigravity-http-error-and-bad-manifest', steps: [
    warm('antigravity', 0, [text('version: 2.40.0\n', 500)]),
    warm('antigravity', 11 * M, [text('version: next\n')]),
    warm('antigravity', 22 * M, [text('name: x\n')]),
    warm('antigravity', 33 * M, [text("files:\n  - url: a\nversion: '2.41.7' # latest\n")]),
  ] },
  { name: 'antigravity-remembered-across-restart', steps: [
    warm('antigravity', 0, [manifest('2.25.0')]),
    { do: 'restart', at: M },
    warm('antigravity', M, [FAIL]),
  ] },
  { name: 'antigravity-env-override', env: { MIXDOG_ANTIGRAVITY_VERSION: ' 9.9.9 ' }, steps: [warm('antigravity', 0, [manifest('2.25.0')])] },
];

const ENV_KEYS = [
  'MIXDOG_DISABLE_LIVE_CLI_VERSIONS', 'MIXDOG_CODEX_VERSION', 'MIXDOG_GROK_CLIENT_VERSION',
  'MIXDOG_CURSOR_CLIENT_VERSION', 'MIXDOG_ANTIGRAVITY_VERSION',
];
const MODULES = {
  codex: 'src/runtime/agent/orchestrator/providers/codex-client-meta.mjs',
  grok: 'src/runtime/agent/orchestrator/providers/grok-client-version.mjs',
  cursor: 'src/runtime/agent/orchestrator/providers/cursor-client-version.mjs',
  antigravity: 'src/runtime/agent/orchestrator/providers/antigravity-oauth-tokens.mjs',
};

const realFetch = globalThis.fetch;
const realNow = Date.now;
let nonce = 0;
let clock = BASE;
Date.now = () => clock;

const lower = (headers = {}) => Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v)]));

async function run(scenario) {
  for (const key of ENV_KEYS) delete process.env[key];
  process.env.MIXDOG_DATA_DIR = mkdtempSync(join(tmpdir(), 'client-versions-'));
  Object.assign(process.env, scenario.env ?? {});
  let mods = {};
  const load = async (dialect) => (mods[dialect] ??= await import(`${pathToFileURL(join(tree, MODULES[dialect])).href}?n=${++nonce}`));
  let fetched = [];
  let queue = [];
  const stub = async (url, opts) => {
    fetched.push({ url: String(url), headers: lower(opts?.headers) });
    const next = queue.shift();
    if (!next || next.fail) throw new Error('offline');
    return { ok: next.status >= 200 && next.status < 300, status: next.status, json: async () => JSON.parse(next.body), text: async () => next.body };
  };
  globalThis.fetch = stub;
  const trace = [];
  for (const step of scenario.steps) {
    clock = BASE + step.at;
    fetched = [];
    queue = [...(step.net ?? [])];
    const out = { do: step.do, dialect: step.dialect ?? null, at: step.at };
    if (step.do === 'restart') {
      mods = {};
    } else if (step.do === 'learn') {
      const mod = await load('grok');
      out.learned = mod.learnGrokRequiredVersion(step.text);
      out.version = mod.grokCliVersion();
    } else {
      const mod = await load(step.dialect);
      const times = step.concurrent ?? 1;
      if (step.dialect === 'codex') {
        await Promise.all(Array.from({ length: times }, () => mod.warmCodexClientVersion()));
        out.version = mod.codexClientVersionSync();
        out.header = mod.codexVersionHeader();
      } else if (step.dialect === 'grok') {
        await Promise.all(Array.from({ length: times }, () => mod.warmGrokCliVersion()));
        out.version = mod.grokCliVersion();
      } else if (step.dialect === 'cursor') {
        await Promise.all(Array.from({ length: times }, () => mod.warmCursorClientVersion()));
        out.version = mod.cursorClientVersion();
      } else {
        const results = await Promise.all(Array.from({ length: times }, () => mod.ensureAntigravityVersion({ fetchFn: stub })));
        out.version = results[0];
      }
    }
    out.fetched = fetched;
    trace.push(out);
  }
  return { name: scenario.name, env: scenario.env ?? {}, steps: scenario.steps, trace };
}

const results = [];
for (const scenario of SCENARIOS) results.push(await run(scenario));
globalThis.fetch = realFetch;
Date.now = realNow;

// The pure helpers on fixed inputs.
const npmMod = await importFrom(tree, 'src/runtime/agent/orchestrator/providers/npm-cli-version.mjs');
const cursorMod = await importFrom(tree, 'src/runtime/agent/orchestrator/providers/cursor-client-version.mjs');
const antiMod = await importFrom(tree, 'src/runtime/agent/orchestrator/providers/antigravity-oauth-tokens.mjs');
const MAX_CASES = [
  ['1.0.0', '1.0.1'], ['1.10.0', '1.9.9', '1.2.0'], [' 2.0.0 ', 'x', null], [undefined, ''], ['1.0', '01.0.0'], ['0.166.0', '0.166.0'],
];
const MANIFESTS = [
  'version: 2.20.3 # latest\n', "version: '2.1.0'\n", 'version: "3.0.0"', 'x: 1\nversion: 1.2.3\nversion: 9.9.9\n', 'version: nope\nversion: 1.2.3\n',
  '  version :   4.5.6  \r\n', 'version: 1.2\n', 'versions: 1.2.3\n', 'version: ""\n',
];
const BUILDS = [
  'https://downloads.cursor.com/lab/2026.11.02-abcdef0/linux/x64/a.tar.gz', 'downloads.cursor.com/lab/2026.11.02-ABCDEF0/', 'no build here',
  'https://downloads.cursor.com/lab/2026.11.02-abc/x/',
];
const NEWER = [
  ['cli-2026.11.02-aaaaaaa', 'cli-2026.10.22-27dcf5f'], ['cli-2026.10.22-27dcf5f', 'cli-2026.10.22-27dcf5f'], ['cli-2026.10.22-bbbbbbb', 'cli-2026.10.22-27dcf5f'],
  ['cli-2026.10.21-ccccccc', 'cli-2026.10.22-27dcf5f'], ['cli-latest', 'cli-2026.10.22-27dcf5f'], ['cli-2026.11.02-aaaaaaa', 'custom'],
];
const NPM_BODIES = ['{"version":"1.2.3"}', '{"version":" 1.2.3 "}', '{"version":"1.2"}', '{"version":0}', '{"version":null}', '{"version":123}', '{}', '[]'];
const helpers = {
  maxSemver: MAX_CASES.map((candidates) => ({ candidates, result: npmMod.maxSemver(...candidates) })),
  manifest: MANIFESTS.map((input) => ({ input, result: antiMod.parseAntigravityManifestVersion(input) })),
  cursorBuild: await Promise.all(BUILDS.map(async (input) => ({ input, result: await cursorMod.parseCursorInstallBuild({ text: async () => input }) }))),
  cursorNewer: NEWER.map(([next, current]) => ({ next, current, result: cursorMod.cursorBuildNewer(next, current) })),
  npmLatest: await Promise.all(NPM_BODIES.map(async (input) => ({ input, result: await npmMod.parseNpmLatest({ json: async () => JSON.parse(input) }) }))),
};

writeJson(join(stage, 'golden.json'), { base: BASE, scenarios: results, helpers });
writeSetManifest(stage, { set: 'client-versions', recorder, command: 'node ' + recorder + ' --tree <tree>', identityTree: tree });
commitStage(stage, finalDir);
