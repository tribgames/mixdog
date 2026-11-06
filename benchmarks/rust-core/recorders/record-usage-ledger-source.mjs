#!/usr/bin/env node
// Golden twin of the process's usage-ledger source (runtime/shared/llm/usage-ledger.mjs):
// `usageLedgerPath()`, `getUsageLedger()` (one ledger per path, opened lazily, its directory and
// file created), `usageLedgerIfOpen()` (asking never opens) and `closeUsageLedgers()` (later gets
// reopen). Node's real functions run scripted sequences over temporary directories; each step
// records the path, whether a ledger is open, which earlier instance it is, and whether the file
// exists. Paths are recorded relative to the run's root as "<root>/...".
//
//   node benchmarks/rust-core/recorders/record-usage-ledger-source.mjs --tree <dir>
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { FIXTURES_ROOT, importFrom, parseArgs, resolveTree, writeJson, writeSetManifest } from './lib/common.mjs';

const cli = parseArgs();
const tree = resolveTree(cli);
const userDir = join(homedir(), '.mixdog');
// The data folder changes under other running agents; what a recorder could add is a new entry,
// a backup, or a ledger under the real data directory.
const count = (dir) => (existsSync(dir) ? readdirSync(dir).length : 0);
const listing = () => [
  ...(existsSync(userDir) ? readdirSync(userDir).sort() : []),
  `backups:${count(join(userDir, 'backups'))}`,
  `usage:${count(join(userDir, 'data', 'usage'))}`,
];
const before = listing();
// Every user directory is replaced before any Mixdog module loads.
const root = mkdtempSync(join(tmpdir(), 'mixdog-ledger-source-'));
for (const name of ['MIXDOG_DATA_DIR', 'MIXDOG_CONFIG_DIR', 'MIXDOG_HOME', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA']) {
  process.env[name] = join(root, name.toLowerCase());
}
process.env.MIXDOG_SKIP_USER_DATA_BACKUP = '1';
delete process.env.MIXDOG_USAGE_LEDGER_PATH;
delete process.env.NODE_TEST_CONTEXT;
const dataDir = process.env.MIXDOG_DATA_DIR;
const ledger = await importFrom(tree, 'src/runtime/shared/llm/usage-ledger.mjs');

// A process that has loaded no price table (this recorder never warms the catalog): the revision
// the refresh stamps and what `priceUsage` answers. The ledger records such rows unpriced.
const catalog = await importFrom(tree, 'src/runtime/shared/llm/model-catalog.mjs');
const { priceUsage } = await importFrom(tree, 'src/runtime/shared/llm/cost.mjs');
const coldRevision = catalog.pricingCatalogRevisionSync();
const priceArgs = [];
for (const [provider, model, kind] of [
  ['anthropic', 'claude-sonnet-4-5', 'api'],
  ['openai-oauth', 'gpt-5', 'oauth'],
  ['openai', 'gpt-4o', 'api'],
  ['google', 'gemini-2.5-pro', 'api'],
  ['mixdog-local', 'local-model', 'local'],
  ['deepseek', 'deepseek-chat', 'api'],
]) {
  for (const historical of [false, true]) {
    priceArgs.push({
      provider,
      model,
      pricingModel: historical ? model : null,
      requestedModel: historical ? null : model,
      inputTokensKnown: historical ? false : true,
      uncachedInputTokens: historical ? 0 : 1200,
      outputTokens: 350,
      cacheReadTokens: 4000,
      cacheWriteTokens: historical ? 0 : 800,
      cacheWrite1hTokens: historical ? null : 100,
      requestServiceTier: historical ? null : 'priority',
      serviceTier: null,
      kind,
      ts: 1_800_000_000_000,
      historical,
    });
  }
}
const cold = {
  revision: coldRevision,
  prices: priceArgs.map((args) => {
    // The ledger's refresh passes these fields; absent ones stay absent for `priceUsage`.
    const given = Object.fromEntries(Object.entries(args).filter(([, v]) => v !== null));
    const priced = priceUsage(given);
    return { args, costUsd: priced.costUsd ?? null, rates: JSON.stringify(priced.rates) };
  }),
};

let seed = 0x1ed6e7;
const rnd = () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const pick = (list) => list[Math.floor(rnd() * list.length)];

const rel = (path) => (path === null ? null : path.replace(root, '<root>').replaceAll('\\', '/'));
// An env value of the script: a name under the root, '' (set but empty), or null (unset).
const envPath = (name) => (name === null ? null : name === '' ? '' : join(root, 'led', name, 'ledger.sqlite'));

const flows = [];
for (let c = 0; c < 80; c += 1) {
  ledger.closeUsageLedgers();
  const seen = new Map();
  const steps = [];
  const count = c < 6 ? 8 : 14;
  for (let s = 0; s < count; s += 1) {
    const op = pick(['env', 'env', 'get', 'get', 'ifOpen', 'close', 'path']);
    const step = { op };
    if (op === 'env') {
      step.value = pick(['a', 'b', 'c', '', null]);
      const value = envPath(step.value);
      if (value === null) delete process.env.MIXDOG_USAGE_LEDGER_PATH;
      else process.env.MIXDOG_USAGE_LEDGER_PATH = value;
    } else if (op === 'path') {
      step.path = rel(ledger.usageLedgerPath());
    } else if (op === 'close') {
      ledger.closeUsageLedgers();
      seen.clear();
    } else {
      const got = op === 'get' ? ledger.getUsageLedger() : ledger.usageLedgerIfOpen();
      step.open = got !== null;
      if (got !== null) {
        if (!seen.has(got)) seen.set(got, seen.size);
        step.instance = seen.get(got);
        step.path = rel(got.path);
        step.fileExists = existsSync(got.path);
      }
    }
    steps.push(step);
  }
  flows.push({ steps });
}
ledger.closeUsageLedgers();
delete process.env.MIXDOG_USAGE_LEDGER_PATH;

const outDir = cli.get('out') ?? join(FIXTURES_ROOT, 'ai-admin');
writeJson(join(outDir, 'usage-ledger-source-twin.json'), {
  domain: 'usage-ledger-source-twin',
  recorder: 'benchmarks/rust-core/recorders/record-usage-ledger-source.mjs',
  defaultPath: rel(join(dataDir, 'usage', 'ledger.sqlite')),
  cold,
  flows,
});
writeSetManifest(outDir, {
  set: 'ai-admin',
  recorder: 'benchmarks/rust-core/recorders/record-usage-ledger-source.mjs',
  command: 'node benchmarks/rust-core/recorders/record-usage-ledger-source.mjs --tree <tree>',
  identityTree: tree,
});
rmSync(root, { recursive: true, force: true });
const after = listing();
if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error('the recorder changed the real user directory');
const all = flows.flatMap((f) => f.steps);
console.log(
  `recorded ${flows.length} flows: ${all.filter((s) => s.op === 'get').length} gets, ` +
    `${all.filter((s) => s.op === 'ifOpen' && s.open).length} open ifOpen, ${all.filter((s) => s.op === 'close').length} closes`,
);