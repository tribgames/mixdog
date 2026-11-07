// Records `canonicalizeUnifiedConfig` (runtime/shared/config.mjs) from today's Node product: what
// `readConfig()` answers for a config file of every shape (every read canonicalizes the document),
// and what a save (`updateSection` / `updateConfig`) leaves on disk.
// Usage: node record-config-canonical.mjs --tree <mixdog checkout> --out <golden.json>
// Every case runs in a child process whose data, home, app-data, backup and tmp directories are
// fresh temp directories (set before any Mixdog import) and whose MIXDOG_* variables are removed.
// The checkout is only imported from, never written.
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const arg = (name) => process.argv[process.argv.indexOf(name) + 1];

if (process.argv.includes('--child')) {
  const cfg = await import(pathToFileURL(join(arg('--tree'), 'src', 'runtime/shared/config.mjs')).href);
  const job = JSON.parse(arg('--job'));
  const out = { read: cfg.readConfig() };
  if (job.write) {
    if (job.write.kind === 'section') cfg.updateSection(job.write.section, () => job.write.value);
    else cfg.updateConfig((current) => ({ ...current, ...job.write.patch }));
    out.written = JSON.parse(readFileSync(join(job.dataDir, 'mixdog-config.json'), 'utf8'));
  }
  console.log(JSON.stringify(out));
  process.exit(0);
}

const kept = { desktop: { keepAwake: false }, providers: { openai: { enabled: true } } };
const retiredRoot = { autoClear: { enabled: true }, compaction: { auto: true }, shell: { name: 'bash' }, mcpServers: { a: { command: 'x' } }, search: { timeout: 5 }, capabilities: { homeAccess: true } };
const reads = [
  ['empty config', {}],
  ['nothing retired', { ...kept, agent: { recap: { enabled: true } }, memory: { cycle1: { interval: '1h' } }, channels: { access: {} } }],
  ['every retired root key', { ...kept, ...retiredRoot }],
  ['lookalike root keys stay', { Shell: 1, autoclear: 1, mcp_servers: 1, Search: 1, capability: 1 }],
  ['retired root keys that are scalars', { shell: 'x', search: 7, capabilities: null, mcpServers: [] }],
  ['agent retired keys', { agent: { outputStyle: 'terse', search: { a: 1 }, capabilities: { b: 2 }, recap: { enabled: false } } }],
  ['agent holding only retired keys stays an empty object', { agent: { outputStyle: 'x', search: {}, capabilities: {} } }],
  ['agent empty object', { agent: {} }],
  ['agent null', { agent: null }],
  ['agent string', { agent: 'x', search: {} }],
  ['agent array', { agent: [{ search: 1 }] }],
  ['agent keys that look retired but are not', { agent: { OutputStyle: 'x', searchTimeout: 1, capability: 2 } }],
  ['agent nested autoClear, compaction and shell stay', { agent: { autoClear: { enabled: false }, compaction: { auto: false }, shell: { name: 'zsh' }, mcpServers: { s: {} } } }],
  ['agent.modules.memory dropped, others kept', { agent: { modules: { memory: { enabled: false }, git: { enabled: true } } } }],
  ['agent.modules holding only memory', { agent: { modules: { memory: false } } }],
  ['agent.modules.memory null', { agent: { modules: { memory: null, office: { enabled: false } } } }],
  ['agent.modules without memory', { agent: { modules: { git: { enabled: true } } } }],
  ['agent.modules empty', { agent: { modules: {} } }],
  ['agent.modules is a string', { agent: { modules: 'memory' } }],
  ['agent.modules is an array', { agent: { modules: [{ memory: 1 }] } }],
  ['root modules.memory is not agent.modules', { modules: { memory: { enabled: false } }, agent: {} }],
  ['memory enabled dropped', { memory: { enabled: true, cycle1: { interval: '1h' } } }],
  ['memory holding only enabled', { memory: { enabled: false } }],
  ['memory empty', { memory: {} }],
  ['memory generated marker kept by the read', { memory: { _generated: true } }],
  ['memory enabled beside the generated marker', { memory: { _generated: true, enabled: true } }],
  ['memory user title only', { memory: { user: { title: 'Dr' } } }],
  ['memory user keeps other keys', { memory: { user: { title: 'Dr', name: 'Kim' }, cycle1: {} } }],
  ['memory user empty', { memory: { user: {}, cycle1: {} } }],
  ['memory user string', { memory: { user: 'Kim', cycle1: {} } }],
  ['memory user array', { memory: { user: ['a'], cycle1: {} } }],
  ['memory user null', { memory: { user: null, cycle1: {} } }],
  ['memory lookalike keys stay', { memory: { Enabled: true, title: 'x', user: { Title: 'y' } } }],
  ['memory null', { memory: null }],
  ['memory string', { memory: 'x' }],
  ['memory array', { memory: [1] }],
  ['channels retired keys', { channels: { promptInjection: { a: 1 }, schedules: [{ id: 1 }], access: { allow: [] }, token: 't' } }],
  ['channels empty', { channels: {} }],
  ['channels null', { channels: null }],
  ['channels array', { channels: [{ schedules: 1 }] }],
  ['channels string', { channels: 'x' }],
  ['root generated marker is stripped by readConfig', { _generated: true, ...kept, shell: {} }],
  ['agent generated marker stays', { agent: { _generated: true, search: {} } }],
  ['everything at once', { _generated: true, ...kept, ...retiredRoot, agent: { outputStyle: 'x', search: {}, capabilities: {}, modules: { memory: {}, git: { enabled: false } }, recap: { enabled: true } }, memory: { enabled: true, user: { title: 't', name: 'n' } }, channels: { promptInjection: {}, schedules: [], token: 't' } }],
];
const initial = { ...kept, shell: { name: 'bash' }, agent: { search: { timeout: 1 }, recap: { enabled: true }, modules: { memory: { enabled: false } } }, memory: { enabled: true, user: { title: 'x', name: 'y' } }, channels: { promptInjection: {}, schedules: [], access: {} } };
const writes = [
  ['a section save writes the canonical document', initial, { kind: 'section', section: 'desktop', value: { keepAwake: true } }],
  ['a saved agent section loses its retired keys', initial, { kind: 'section', section: 'agent', value: { recap: { enabled: false }, outputStyle: 'terse', search: {}, capabilities: { homeAccess: true }, modules: { memory: { enabled: true }, git: { enabled: true } } } }],
  ['a saved memory section loses its retired keys', initial, { kind: 'section', section: 'memory', value: { enabled: false, user: { title: 'Dr', language: 'ko' }, cycle1: { interval: '2h' } } }],
  ['a saved channels section loses its retired keys', initial, { kind: 'section', section: 'channels', value: { promptInjection: { a: 1 }, schedules: [{ id: 1 }], token: 't' } }],
  ['a whole-config save drops retired root keys', initial, { kind: 'config', patch: { autoClear: { x: 1 }, compaction: {}, mcpServers: { a: {} }, search: {}, capabilities: {}, desktop: { keepAwake: true } } }],
];

const work = mkdtempSync(join(tmpdir(), 'cfgcanon-'));
const run = (index, config, write) => {
  const dirs = Object.fromEntries(['data', 'home', 'appdata', 'localappdata', 'backups', 'tmp'].map((n) => [n, join(work, `${n}-${index}`)]));
  for (const d of Object.values(dirs)) mkdirSync(d, { recursive: true });
  writeFileSync(join(dirs.data, 'mixdog-config.json'), JSON.stringify(config));
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('MIXDOG_')));
  Object.assign(env, {
    MIXDOG_DATA_DIR: dirs.data,
    MIXDOG_HOME: dirs.home,
    MIXDOG_USER_DATA_BACKUP_ROOT: dirs.backups,
    MIXDOG_SKIP_USER_DATA_BACKUP: '1',
    MIXDOG_QUIET_MEMORY_LOG: '1',
    HOME: dirs.home,
    USERPROFILE: dirs.home,
    APPDATA: dirs.appdata,
    LOCALAPPDATA: dirs.localappdata,
    TEMP: dirs.tmp,
    TMP: dirs.tmp,
    TMPDIR: dirs.tmp,
  });
  const job = JSON.stringify({ dataDir: dirs.data, write });
  const child = spawnSync(process.execPath, [process.argv[1], '--child', '--tree', arg('--tree'), '--job', job], { env, encoding: 'utf8' });
  if (child.status !== 0) throw new Error(`case ${index}: ${child.stderr}`);
  return JSON.parse(child.stdout.trim().split('\n').at(-1));
};
const cases = [];
let index = 0;
for (const [name, config] of reads) cases.push({ name, config, expected: run(index++, config, null).read });
for (const [name, config, write] of writes) {
  const seen = run(index++, config, write);
  cases.push({ name, config, write, expected: seen.read, written: seen.written });
}
writeFileSync(arg('--out'), `${JSON.stringify({ node: process.version, cases }, null, 2)}\n`);
rmSync(work, { recursive: true, force: true });
console.log(`recorded ${cases.length} cases`);
