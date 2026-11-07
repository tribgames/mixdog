// Records what the memory cycles read of the product configuration from today's Node product:
// `readSection('memory')`, `memoryCyclesEnabled()` and `resolveMaintenancePreset('memory')`
// over config files of every shape, and `envFlag` over its spellings.
// Usage: node record-cycle-config.mjs --tree <mixdog checkout> --out <golden.json>
// Each case runs in a child process on a fresh temp MIXDOG_DATA_DIR (set before any Mixdog
// import), with every MIXDOG_* variable of the caller removed.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const arg = (name) => process.argv[process.argv.indexOf(name) + 1];

if (process.argv.includes('--child')) {
  const tree = arg('--tree');
  const src = (p) => pathToFileURL(join(tree, 'src', p)).href;
  const flags = await import(src('runtime/memory/lib/memory-config-flags.mjs'));
  const preset = await import(src('runtime/agent/orchestrator/maintenance-preset.mjs'));
  const env = await import(src('runtime/shared/env.mjs'));
  const out = {
    memory: flags.readMainConfig(),
    cyclesEnabled: flags.memoryCyclesEnabled(),
    preset: preset.resolveMaintenancePreset('memory'),
  };
  if (process.argv.includes('--env-table')) {
    out.envFlag = [];
    for (const value of [undefined, '', ' ', '1', ' 1 ', 'true', 'TRUE', 'Yes', 'on', '0', 'false', 'OFF', 'no', 'maybe', '2']) {
      const row = { value: value ?? null };
      for (const fallback of [false, true]) {
        if (value === undefined) delete process.env.MIXDOG_PROBE;
        else process.env.MIXDOG_PROBE = value;
        row[fallback ? 'whenTrue' : 'whenFalse'] = env.envFlag('MIXDOG_PROBE', fallback);
      }
      out.envFlag.push(row);
    }
  }
  console.log(JSON.stringify(out));
  process.exit(0);
}

const route = (extra = {}) => ({ provider: 'anthropic-oauth', model: 'claude-haiku-4-5', ...extra });
const cases = [
  { name: 'no config file', config: null },
  { name: 'empty config', config: {} },
  { name: 'memory section only', config: { memory: { cycle1: { interval: '10m', batchSize: 40 }, enabled: true } } },
  // Every read canonicalizes the document first (`canonicalizeUnifiedConfig`): retired keys go.
  { name: 'memory section holding only the retired enabled key', config: { memory: { enabled: false } } },
  { name: 'memory section that is empty', config: { memory: {} } },
  { name: 'memory enabled beside the generated marker', config: { memory: { _generated: true, enabled: true } } },
  { name: 'memory user title only', config: { memory: { user: { title: 'Dr' } } } },
  { name: 'memory user keeps its other keys', config: { memory: { user: { title: 'Dr', name: 'Kim', language: 'ko' }, cycle1: { interval: '1h' } } } },
  { name: 'memory user is empty', config: { memory: { user: {}, cycle1: { interval: '1h' } } } },
  { name: 'memory user is a string', config: { memory: { user: 'Kim', cycle1: { interval: '1h' } } } },
  { name: 'memory user is an array', config: { memory: { user: ['a'], cycle1: { interval: '1h' } } } },
  { name: 'memory user is null', config: { memory: { user: null, enabled: true, cycle1: { interval: '1h' } } } },
  { name: 'memory keys that look retired but are not', config: { memory: { Enabled: true, title: 'x', user: { Title: 'y' } } } },
  { name: 'config root is an array', config: [{ memory: { cycle1: { interval: '1h' } } }] },
  { name: 'memory section with the generated marker', config: { memory: { _generated: true, cycle1: { interval: '5m' } } } },
  { name: 'memory section is null', config: { memory: null } },
  { name: 'memory section is an array', config: { memory: [1, 2] } },
  { name: 'memory section is a string', config: { memory: 'x' } },
  { name: 'agent section with the generated marker', config: { agent: { _generated: true, recap: { enabled: false } } } },
  { name: 'recap off', config: { agent: { recap: { enabled: false } } } },
  { name: 'recap on', config: { agent: { recap: { enabled: true } } } },
  { name: 'recap empty object', config: { agent: { recap: {} } } },
  { name: 'recap is a string', config: { agent: { recap: 'off' } } },
  { name: 'recap enabled is the string false', config: { agent: { recap: { enabled: 'false' } } } },
  { name: 'recap enabled is zero', config: { agent: { recap: { enabled: 0 } } } },
  { name: 'recap enabled is null', config: { agent: { recap: { enabled: null } } } },
  { name: 'recap is an array', config: { agent: { recap: [] } } },
  { name: 'agent section is null', config: { agent: null } },
  { name: 'agent section is a string', config: { agent: 'x' } },
  { name: 'memory route stored', config: { agent: { maintenance: { memory: route() } } } },
  { name: 'memory route keeps extra fields', config: { agent: { maintenance: { memory: route({ effort: 'low', fast: true, note: { a: 1 } }) } } } },
  { name: 'memory route without a model', config: { agent: { maintenance: { memory: { provider: 'anthropic-oauth' } } } } },
  { name: 'memory route without a provider', config: { agent: { maintenance: { memory: { model: 'm' } } } } },
  { name: 'memory route with an empty model', config: { agent: { maintenance: { memory: { provider: 'p', model: '' } } } } },
  { name: 'memory route with a numeric model', config: { agent: { maintenance: { memory: { provider: 'p', model: 7 } } } } },
  { name: 'memory route is an array', config: { agent: { maintenance: { memory: [route()] } } } },
  { name: 'memory route is a string', config: { agent: { maintenance: { memory: 'haiku' } } } },
  { name: 'memory route is null', config: { agent: { maintenance: { memory: null } } } },
  { name: 'only the webhook route is stored', config: { agent: { maintenance: { webhook: route() } } } },
  { name: 'maintenance is an array', config: { agent: { maintenance: [route()] } } },
  { name: 'maintenance is a string', config: { agent: { maintenance: 'memory' } } },
  { name: 'recap off and a route', config: { agent: { recap: { enabled: false }, maintenance: { memory: route() } } } },
  { name: 'secondary process', config: { agent: { recap: { enabled: true } } }, env: { MIXDOG_MEMORY_SECONDARY: '1' } },
  { name: 'secondary spelled yes', config: {}, env: { MIXDOG_MEMORY_SECONDARY: ' Yes ' } },
  { name: 'secondary spelled 0', config: {}, env: { MIXDOG_MEMORY_SECONDARY: '0' } },
  { name: 'secondary spelled as a typo', config: {}, env: { MIXDOG_MEMORY_SECONDARY: 'sure' } },
  { name: 'cycles disabled by the environment', config: { agent: { recap: { enabled: true } } }, env: { MIXDOG_MEMORY_DISABLE_CYCLES: 'true' } },
  { name: 'cycles disabled spelled off', config: {}, env: { MIXDOG_MEMORY_DISABLE_CYCLES: 'off' } },
  { name: 'both environment switches', config: {}, env: { MIXDOG_MEMORY_SECONDARY: '1', MIXDOG_MEMORY_DISABLE_CYCLES: '1' } },
];

const work = mkdtempSync(join(tmpdir(), 'cyclecfg-'));
const results = [];
let envTable = null;
for (const [index, c] of cases.entries()) {
  const data = join(work, `data-${index}`);
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('MIXDOG_')));
  Object.assign(env, { MIXDOG_DATA_DIR: data, MIXDOG_QUIET_MEMORY_LOG: '1' }, c.env ?? {});
  const { mkdirSync } = await import('node:fs');
  mkdirSync(data, { recursive: true });
  if (c.config !== null) writeFileSync(join(data, 'mixdog-config.json'), JSON.stringify(c.config));
  const args = [process.argv[1], '--child', '--tree', arg('--tree'), ...(index === 0 ? ['--env-table'] : [])];
  const run = spawnSync(process.execPath, args, { env, encoding: 'utf8' });
  if (run.status !== 0) throw new Error(`${c.name}: ${run.stderr}`);
  const seen = JSON.parse(run.stdout.trim().split('\n').at(-1));
  if (seen.envFlag) envTable = seen.envFlag;
  delete seen.envFlag;
  results.push({ name: c.name, config: c.config, env: c.env ?? {}, ...seen });
}
writeFileSync(arg('--out'), `${JSON.stringify({ node: process.version, envFlag: envTable, cases: results }, null, 2)}\n`);
rmSync(work, { recursive: true, force: true });
console.log(`recorded ${results.length} cases`);
