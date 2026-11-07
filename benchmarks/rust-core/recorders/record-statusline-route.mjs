#!/usr/bin/env node
// Genuine 1.4.5 statusline route write: Node's own `writeStatuslineRoute` (session-runtime/statusline-route.mjs)
// handed the real gateway route store (`vendor/statusline/src/gateway/session-routes.mjs`) on a fresh temp data
// dir; after every step the golden holds the exact bytes of `gateway-session-routes.json` and its `.bak`.
// `Date.now` is fixed per call (the store stamps `updatedAt` from it); nothing is masked.
//
//   node benchmarks/rust-core/recorders/record-statusline-route.mjs --tree <tree w/ node_modules>
// Output: native/core/fixtures/statusline-route/golden.json
import { existsSync, mkdtempSync, readFileSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { commitStage, importFrom, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest, FIXTURES_ROOT } from './lib/common.mjs';

// Every user dir Node reads is a fresh temp dir BEFORE any Mixdog module loads.
const sandbox = mkdtempSync(join(tmpdir(), 'rsl-'));
for (const [key, name] of [['MIXDOG_HOME', 'home'], ['HOME', 'h'], ['USERPROFILE', 'up'], ['APPDATA', 'appdata'], ['LOCALAPPDATA', 'local']]) {
  mkdirSync(join(sandbox, name), { recursive: true });
  process.env[key] = join(sandbox, name);
}
process.env.MIXDOG_SKIP_USER_DATA_BACKUP = '1';

const args = parseArgs();
const tree = resolveTree(args);
const routes = await importFrom(tree, 'src/vendor/statusline/src/gateway/session-routes.mjs');
const { writeStatuslineRoute } = await importFrom(tree, 'src/session-runtime/statusline-route.mjs');

const T0 = 1_800_000_000_000;
const DAY = 24 * 60 * 60 * 1000;
const realNow = Date.now;
const SID = 'sess_abcdef01';
const SID2 = 'sess_abcdef02';
const full = { provider: ' anthropic ', model: 'claude-opus-4', preset: { id: 'p1', name: 'Opus', modelDisplay: 'Claude Opus', fast: true }, fast: false, effectiveEffort: 'high', modelDisplay: 'ignored when the preset has one' };

const seedHosts = {};
for (let i = 0; i < 102; i += 1) {
  seedHosts[`sess_seed${String(i).padStart(4, '0')}#${1000 + i}`] = { mode: 'fixed', defaultProvider: 'openai', defaultModel: 'gpt-x', sessionId: `sess_seed${String(i).padStart(4, '0')}`, clientHostPid: 1000 + i, updatedAt: T0 - 60_000 - i * 1000 };
}
const seed = {
  version: 2,
  updatedAt: T0 - 5000,
  sessions: {
    sess_oldlegacy: { mode: 'fixed', defaultProvider: 'openai', defaultModel: 'gpt-old', sessionId: 'sess_oldlegacy', updatedAt: T0 - 15 * DAY },
    sess_newlegacy: { mode: 'fixed', defaultProvider: 'openai', defaultModel: 'gpt-new', sessionId: 'sess_newlegacy', updatedAt: T0 - 1000 },
    sess_nostamp0: { mode: 'fixed', defaultProvider: 'openai', defaultModel: 'gpt-none', sessionId: 'sess_nostamp0' },
  },
  sessionHosts: seedHosts,
};

const call = (session, route, now = T0) => ({ session, route, now });
const cases = [
  { name: 'every field: preset, route fast, effort, trimmed provider', steps: [[call({ id: SID, clientHostPid: 4242 }, full)]] },
  { name: 'preset fast and the route model display', steps: [[call({ id: SID, clientHostPid: 4242 }, { provider: 'openai', model: 'gpt-5', preset: { id: '  ', name: 'Fast', fast: true }, modelDisplay: ' GPT 5 ' })]] },
  { name: 'non-string preset id and effort drop; a numeric model display is its string', steps: [[call({ id: SID, clientHostPid: 7 }, { provider: 'openai', model: 'gpt-5', preset: { id: 5, name: 'n', modelDisplay: 7 }, effectiveEffort: 3 })]] },
  { name: 'a route with no usable provider or model writes nothing', steps: [[call({ id: SID, clientHostPid: 7 }, { provider: '', model: 'm' })], [call({ id: SID, clientHostPid: 7 }, { provider: 'p' })], [call({ id: SID, clientHostPid: 7 }, { provider: 5, model: 'm' })]] },
  { name: 'a session id the store never keys, no id, no route: nothing', steps: [[call({ id: 'abc', clientHostPid: 7 }, { provider: 'p', model: 'm' })], [call({ clientHostPid: 7 }, { provider: 'p', model: 'm' })], [call({ id: SID, clientHostPid: 7 }, null)]] },
  { name: 'a later write keeps the key position and refreshes updatedAt; a second session and host', steps: [[call({ id: SID, clientHostPid: 11 }, full, T0)], [call({ id: SID2, clientHostPid: 11 }, { provider: 'openai', model: 'gpt-5' }, T0 + 1000)], [call({ id: SID, clientHostPid: 11 }, { provider: 'openai', model: 'gpt-5', fast: true }, T0 + 2000)], [call({ id: SID, clientHostPid: 12 }, full, T0 + 3000)]] },
  { name: 'writes queued in one tick land in one update with one updatedAt', steps: [[call({ id: SID, clientHostPid: 21 }, full, T0), call({ id: SID2, clientHostPid: 21 }, { provider: 'openai', model: 'gpt-5' }, T0 + 5), call({ id: SID, clientHostPid: 21 }, { provider: 'openai', model: 'gpt-6' }, T0 + 9)]] },
  { name: 'a write prunes entries past the TTL, those without a stamp, and past the caps', initial: seed, steps: [[call({ id: SID, clientHostPid: 31 }, full, T0)]] },
];

function readText(path) {
  return existsSync(path) ? readFileSync(path, 'utf8') : null;
}

const out = [];
for (const spec of cases) {
  const dir = mkdtempSync(join(sandbox, 'data-'));
  process.env.MIXDOG_DATA_DIR = dir;
  const store = routes.gatewaySessionRoutesPath();
  const initial = spec.initial ? `${JSON.stringify(spec.initial)}\n` : null;
  if (initial !== null) writeFileSync(store, initial);
  const steps = [];
  for (const batch of spec.steps) {
    for (const entry of batch) {
      Date.now = () => entry.now;
      writeStatuslineRoute(routes, entry.session, entry.route);
    }
    Date.now = () => batch[batch.length - 1].now;
    await routes.gatewaySessionRoutesSettled();
    steps.push({ calls: batch, file: readText(store), bak: readText(`${store}.bak`) });
  }
  out.push({ name: spec.name, initial, steps });
  rmSync(dir, { recursive: true, force: true });
}
Date.now = realNow;
rmSync(sandbox, { recursive: true, force: true });

const finalOut = join(FIXTURES_ROOT, 'statusline-route');
const stage = stageSet(finalOut);
writeJson(join(stage, 'golden.json'), {
  note: 'bytes of gateway-session-routes.json (and .bak) after each writeStatuslineRoute step; calls inside one step run in one tick',
  cases: out,
});
writeSetManifest(stage, {
  set: 'statusline-route',
  recorder: 'benchmarks/rust-core/recorders/record-statusline-route.mjs',
  command: 'node benchmarks/rust-core/recorders/record-statusline-route.mjs --tree <tree>',
  extra: { cases: out.length },
  identityTree: tree,
});
commitStage(stage, finalOut);
console.log(`cases=${out.length}`);
