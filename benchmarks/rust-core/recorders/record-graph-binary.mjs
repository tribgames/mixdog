#!/usr/bin/env node
// Golden twin of the graph binary fetcher, from the real Node code
// (runtime/agent/orchestrator/tools/graph-binary-fetcher.mjs over runtime/shared/native-asset.mjs):
//
//   graph-binary.json — `findCachedGraphBinary` / `ensureGraphBinary` on a temp data dir for every
//     manifest the fetcher distinguishes (install, cache hit, a damaged copy, a bad checksum, an
//     untrusted asset, an unsupported platform, stale files to collect, a failing download), with
//     the download stubbed through the fetcher's own `options.download` seam; and
//     `createBinaryDownloader` (the production download) against a local stub server: a body, a
//     4xx answer (terminal) and a 5xx answer that the retry schedule recovers from.
//
// A release asset is trusted only at its exact github url, so the install flow cannot be served by
// a local server; the downloader is therefore recorded on its own. Host-dependent text (platform
// key, `.exe`, urls, the stub server's base) is recorded as <PKEY>, <SUFFIX>, <URL>, <BASE>.
//
//   node benchmarks/rust-core/recorders/record-graph-binary.mjs --tree <dir with node_modules>
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Nothing of the product's user directories is touched: the fetcher only sees the temp data dir.
const home = mkdtempSync(join(tmpdir(), 'graph-binary-'));
for (const name of ['MIXDOG_HOME', 'MIXDOG_DATA_DIR', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA']) {
  process.env[name] = join(home, name.toLowerCase());
  mkdirSync(process.env[name], { recursive: true });
}

const { FIXTURES_ROOT, commitStage, stageSet, importFrom, parseArgs, resolveTree, writeJson, writeSetManifest } = await import('./lib/common.mjs');

const args = parseArgs();
const tree = resolveTree(args);
const fetcher = await importFrom(tree, 'src/runtime/agent/orchestrator/tools/graph-binary-fetcher.mjs');
const asset = await importFrom(tree, 'src/runtime/shared/native-asset.mjs');

const OUT = join(FIXTURES_ROOT, 'native-asset');
const stage = stageSet(OUT);

const PKEY = asset.platformKeyCandidates()[0];
const SUFFIX = asset.binSuffix();
const BYTES = 'graph-binary-stub\n';
const SHA = createHash('sha256').update(BYTES).digest('hex');
const VERSION = '1.2.3';
const URL_OF = (version, key = PKEY) => `https://github.com/tribgames/mixdog/releases/download/graph-v${version}/mixdog-graph-${key}${SUFFIX}`;

// Host values out, placeholders in (longest first: the url contains the key and the suffix).
const generic = (text) =>
  String(text).split(URL_OF(VERSION)).join('<URL>').split(PKEY).join('<PKEY>');
const FILE = `mixdog-graph-${VERSION}${SUFFIX}`;
const genericName = (name) => name.replace(/^(mixdog-graph-\d+\.\d+\.\d+)(\.exe)?/, '$1<SUFFIX>');
const templated = (manifest) =>
  JSON.parse(JSON.stringify(manifest).split(URL_OF(VERSION)).join('<URL>').split(PKEY).join('<PKEY>').split(SUFFIX || '\u0000').join('<SUFFIX>'));

const good = (over = {}) => ({ url: URL_OF(VERSION), sha256: SHA, ...over });
const manifestOf = (assets, version = VERSION) => ({ version, assets });

const SCENARIOS = [
  { name: 'install', manifest: manifestOf({ [PKEY]: good() }) },
  { name: 'cache-hit', manifest: manifestOf({ [PKEY]: good() }), runs: 2 },
  { name: 'damaged-copy', manifest: manifestOf({ [PKEY]: good() }), seed: [{ name: FILE, content: 'not the binary' }] },
  { name: 'intact-copy', manifest: manifestOf({ [PKEY]: good() }), seed: [{ name: FILE, content: BYTES }] },
  { name: 'uppercase-sha', manifest: manifestOf({ [PKEY]: good({ sha256: SHA.toUpperCase() }) }) },
  { name: 'bad-checksum', manifest: manifestOf({ [PKEY]: good() }), served: 'other bytes\n' },
  { name: 'download-fails', manifest: manifestOf({ [PKEY]: good() }), fail: 'boom' },
  { name: 'unsupported-platform', manifest: manifestOf({ 'sunos-x64': { url: URL_OF(VERSION, 'sunos-x64'), sha256: SHA }, 'plan9-arm64': good() }) },
  { name: 'no-assets', manifest: { version: VERSION } },
  { name: 'untrusted-url', manifest: manifestOf({ [PKEY]: good({ url: 'https://example.com/mixdog-graph' }) }) },
  { name: 'bad-version', manifest: manifestOf({ [PKEY]: good() }, '1.2') },
  { name: 'leading-zero-version', manifest: manifestOf({ [PKEY]: good({ url: URL_OF('01.2.3') }) }, '01.2.3') },
  { name: 'bad-sha', manifest: manifestOf({ [PKEY]: good({ sha256: 'zz' }) }) },
  {
    name: 'stale-files-collected',
    manifest: manifestOf({ [PKEY]: good() }),
    seed: [
      { name: `mixdog-graph-0.0.1${SUFFIX}`, content: 'old' },
      { name: `mixdog-graph-0.0.1${SUFFIX}.tmp-1-1`, content: 'tmp' },
      { name: 'manifest.json', content: '{}' },
      { name: 'unrelated.txt', content: 'keep' },
    ],
  },
];

const install = [];
for (const scenario of SCENARIOS) {
  const dataDir = mkdtempSync(join(home, 'data-'));
  const dir = join(dataDir, 'graph-bin');
  if (scenario.seed) {
    mkdirSync(dir, { recursive: true });
    for (const file of scenario.seed) writeFileSync(join(dir, file.name), file.content);
  }
  const calls = [];
  const options = {
    bundledManifest: scenario.manifest,
    download: async (url, dest) => {
      calls.push({ url: generic(url), tmpName: dest.startsWith(join(dir, `${FILE}.tmp-`)) });
      if (scenario.fail) throw new Error(scenario.fail);
      writeFileSync(dest, scenario.served ?? BYTES);
    },
  };
  const rel = (path) => (path === null ? null : genericName(path.slice(dir.length + 1)));
  const findBefore = rel(fetcher.findCachedGraphBinary(dataDir, options));
  const outcomes = [];
  for (let i = 0; i < (scenario.runs ?? 1); i += 1) {
    try {
      outcomes.push({ ok: rel(await fetcher.ensureGraphBinary(dataDir, options)) });
    } catch (error) {
      outcomes.push({ error: generic(error.message) });
    }
  }
  const findAfter = rel(fetcher.findCachedGraphBinary(dataDir, options));
  let files = [];
  try {
    files = readdirSync(dir).sort().map((name) => (/\.tmp-\d+-\d+$/.test(name) ? '<TMP>' : genericName(name)));
  } catch {
    /* no directory */
  }
  install.push({
    name: scenario.name,
    manifest: templated(scenario.manifest),
    seed: (scenario.seed ?? []).map((file) => ({ name: genericName(file.name), content: file.content })),
    served: scenario.served ?? null,
    fail: scenario.fail ?? null,
    runs: scenario.runs ?? 1,
    findBefore,
    outcomes,
    calls,
    findAfter,
    files,
  });
}

// --- the production downloader against a local server ---------------------------------------------
const hits = new Map();
const server = createServer((req, res) => {
  const n = (hits.get(req.url) ?? 0) + 1;
  hits.set(req.url, n);
  if (req.url === '/ok') {
    res.writeHead(200, { 'content-length': Buffer.byteLength(BYTES) });
    res.end(BYTES);
  } else if (req.url === '/missing') {
    res.writeHead(404);
    res.end('nope');
  } else if (req.url === '/flaky' && n === 1) {
    res.writeHead(500);
    res.end('later');
  } else {
    res.writeHead(200, { 'content-length': Buffer.byteLength(BYTES) });
    res.end(BYTES);
  }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const download = asset.createBinaryDownloader({ name: 'graph', label: '[graph-fetcher]' });
const downloads = [];
for (const route of ['/ok', '/missing', '/flaky']) {
  const dest = join(home, `download-${route.slice(1)}`);
  let outcome;
  try {
    await download(`${base}${route}`, dest);
    outcome = { ok: createHash('sha256').update(readFileSync(dest)).digest('hex') };
  } catch (error) {
    outcome = { error: String(error.message).split(base).join('<BASE>') };
  }
  downloads.push({ route, outcome, requests: hits.get(route) ?? 0 });
}
server.close();

writeJson(join(stage, 'graph-binary.json'), { recordedOn: PKEY, node: process.version, version: VERSION, sha256: SHA, bytes: BYTES, install, downloads });
commitStage(stage, OUT);
writeSetManifest(OUT, {
  set: 'native-asset',
  recorder: 'benchmarks/rust-core/recorders/record-graph-binary.mjs',
  command: 'node benchmarks/rust-core/recorders/record-graph-binary.mjs --tree <dir with node_modules>',
});
rmSync(home, { recursive: true, force: true });
console.log(`graph binary: ${install.length} installs, ${downloads.length} downloads`);
