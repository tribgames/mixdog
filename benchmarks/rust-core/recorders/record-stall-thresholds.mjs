#!/usr/bin/env node
// Golden twin of `resolveAgentStallThresholds(agent, env)` (`orchestrator/stall-policy.mjs`): the warn, abort and
// first-byte deadlines, in seconds, of each agent under several `STALL_TIMEOUT_S` values. The module reads the
// variable once at import, so each value runs in its own child process. For each agent the recording also holds
// what the thresholds read of it: whether `getHiddenAgent(agent)` is set and its `stallCap.idleSeconds`.
//
//   node benchmarks/rust-core/recorders/record-stall-thresholds.mjs --tree <dir>
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { FIXTURES_ROOT, importFrom, parseArgs, resolveTree } from './lib/common.mjs';

const AGENTS = [null, '', 'worker', 'reviewer', 'heavy-worker', 'maintainer', 'lead', 'writer', 'explore-agent', 'cycle1-agent', 'title-agent', 'recap-agent', 'advisor', 'no-such-agent'];
const ENVS = [null, '120', '900', '5', 'abc', '0', '-30', '45s'];

if (process.argv.includes('--child')) {
  const tree = process.argv[process.argv.indexOf('--tree') + 1];
  const sandbox = mkdtempSync(join(tmpdir(), 'stall-thresholds-'));
  for (const key of ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'MIXDOG_HOME', 'MIXDOG_DATA_DIR']) {
    const directory = join(sandbox, key);
    mkdirSync(directory);
    process.env[key] = directory;
  }
  const stall = await import(pathToFileURL(join(tree, 'src/runtime/agent/orchestrator/stall-policy.mjs')).href);
  const hiddenMod = await import(pathToFileURL(join(tree, 'src/runtime/agent/orchestrator/internal-agents.mjs')).href);
  const rows = AGENTS.map((agent) => {
    const hidden = agent ? hiddenMod.getHiddenAgent(agent) : null;
    return { agent, hidden: Boolean(hidden), stallCapIdleSeconds: hidden?.stallCap?.idleSeconds ?? null, ...stall.resolveAgentStallThresholds(agent) };
  });
  process.stdout.write(JSON.stringify(rows));
  rmSync(sandbox, { recursive: true, force: true });
  process.exit(0);
}

const tree = resolveTree(parseArgs());
const cases = ENVS.map((value) => {
  const env = { ...process.env };
  delete env.STALL_TIMEOUT_S;
  if (value !== null) env.STALL_TIMEOUT_S = value;
  const out = execFileSync(process.execPath, [process.argv[1], '--child', '--tree', tree], { env, encoding: 'utf8' });
  return { env: value, rows: JSON.parse(out) };
});
await importFrom(tree, 'src/runtime/agent/orchestrator/stall-policy.mjs');
mkdirSync(join(FIXTURES_ROOT, 'stall-thresholds'), { recursive: true });
writeFileSync(join(FIXTURES_ROOT, 'stall-thresholds', 'golden.json'), `${JSON.stringify({ domain: 'stall-thresholds', recorder: 'benchmarks/rust-core/recorders/record-stall-thresholds.mjs', cases }, null, 1)}\n`);
console.log(`recorded ${cases.length} environments`);
process.exit(0);
