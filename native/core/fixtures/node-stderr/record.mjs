// Records the stderr lines real Node (the reference tree, b6f10295a) writes for a few `[module] ...` diagnostics.
// usage: node record.mjs <reference-repo-root> > lines.json
// Run-specific text is replaced by a token, which a replay swaps for its own value: <DIR> (the temp dir),
// <BASE> (the local server's origin), <STAMP> (the quarantine timestamp).
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.argv[2];
const load = (rel) => import(pathToFileURL(path.join(root, rel)).href);
const { GeminiProvider } = await load('src/runtime/agent/orchestrator/providers/gemini.mjs');
const { createBinaryDownloader } = await load('src/runtime/shared/native-asset.mjs');
const { readJsonStateSync } = await load('src/runtime/shared/atomic-file.mjs');

const written = [];
const realWrite = process.stderr.write.bind(process.stderr);
const record = async (name, run) => {
  const before = written.length;
  process.stderr.write = (chunk) => (written.push(String(chunk)), true);
  try {
    await run();
  } finally {
    process.stderr.write = realWrite;
  }
  return [name, written.slice(before)];
};

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'node-stderr-'));
const sites = {};

const [, gemini] = await record('gemini', async () => {
  const provider = new GeminiProvider({ apiKey: 'k' });
  provider._fetch = async () => ({
    ok: false,
    status: 400,
    statusText: 'Bad Request',
    headers: new Map(),
    text: async () => '{"error":{"message":"bad things"}}',
  });
  await provider._createGeminiCache({
    apiKey: 'k',
    model: 'gemini-2.5-pro',
    ttlSeconds: 300,
    request: { contents: [{ role: 'user', parts: [{ text: 'x' }] }] },
    prefix: { cachePrefixContentCount: 1, cachePrefixHash: 'h' },
    globalCacheKey: 'g',
    credentialFingerprint: 'f',
    priorCacheName: null,
    canAttachState: false,
    opts: {},
    currentIter: 0,
  });
});
sites.geminiCreate400 = gemini;

let hits = 0;
const server = http.createServer((_req, res) => {
  hits += 1;
  res.statusCode = hits === 1 ? 500 : 200;
  res.end(hits === 1 ? 'later' : 'bytes');
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const [, retry] = await record('retry', async () => {
  await createBinaryDownloader({ name: 'graph', label: '[graph-fetcher]' })(`${base}/flaky`, path.join(dir, 'bin'));
});
server.close();
sites.graphDownloadRetry = retry.map((line) => line.replaceAll(base, '<BASE>'));

const state = path.join(dir, 'state.json');
fs.writeFileSync(state, '{"a":');
const [, damaged] = await record('damaged', async () => {
  readJsonStateSync(state, { fallback: {} });
});
sites.stateDamaged = damaged.map((line) => line.replaceAll(dir, '<DIR>').replace(/\.corrupt-\d+/g, '.corrupt-<STAMP>'));
const stamp = fs.readdirSync(dir).find((n) => n.startsWith('state.json.corrupt-')).split('-')[1];

process.stdout.write(`${JSON.stringify({ source: 'b6f10295a', stamp: Number(stamp), sites }, null, 2)}\n`);
process.exit(0);
