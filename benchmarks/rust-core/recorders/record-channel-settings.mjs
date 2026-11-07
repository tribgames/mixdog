// Records Node's real channels-section writer (`setWebhookConfigAsync`, session-runtime/services/channel-admin.mjs)
// over seeded config files: what each patch returns (the effective channels config, defaults filled in) and what the
// file's `channels` section holds afterwards. Usage: node record-channel-settings.mjs --tree <mixdog checkout> --out <golden.json>
import { execFileSync } from 'node:child_process';
import { mkdtempSync,mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const arg = (name) => process.argv[process.argv.indexOf(name) + 1];
const tree = resolve(arg('--tree'));
const out = resolve(arg('--out'));

const SEEDS = {
  absent: undefined,
  empty: {},
  stored_defaults: { webhook: { enabled: true, port: 3333 } },
  stored_custom: { webhook: { enabled: false, port: 4000, domain: 'hooks.example' } },
  with_extras: {
    secret: 'global-secret',
    allowUnsignedWebhooks: true,
    endpoints: { gh: { enabled: true, parser: 'github', allowUnsigned: false } },
    promptInjection: { on: true },
    schedules: [{ name: 'x' }],
    webhook: { port: 5000, keep: 1 },
  },
  enabled_not_boolean: { webhook: { enabled: 'yes', port: '6000' } },
};

const PATCHES = [
  {},
  { enabled: false },
  { enabled: true },
  { enabled: 'yes' },
  { port: 4000 },
  { port: '8080' },
  { port: 'abc' },
  { port: 0 },
  { port: 3333 },
  { port: 70000 },
  { port: '3.5' },
  { port: -5 },
  { port: '1e3' },
  { port: 'Infinity' },
  { port: 3333 },
  { domain: ' d.example ' },
  { domain: '' },
  { enabled: false, port: '9000', domain: 'x.example' },
];

// One child process per seed: the config module caches its path and reads.
if (process.argv.includes('--seed')) {
  const seedName = arg('--seed');
  const seed = SEEDS[seedName];
  const home = arg('--home');
  mkdirSync(join(home, 'data'), { recursive: true });
  for (const key of ['MIXDOG_HOME', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA']) process.env[key] = home;
  process.env.MIXDOG_DATA_DIR = join(home, 'data');
  process.env.MIXDOG_SKIP_USER_DATA_BACKUP = '1';
  const admin = await import(pathToFileURL(join(tree, 'src/session-runtime/services/channel-admin.mjs')).href);
  const { configPath } = await import(pathToFileURL(join(tree, 'src/runtime/shared/config.mjs')).href);
  const file = configPath();
  mkdirSync(join(file, '..'), { recursive: true });
  const doc = { agent: {} };
  if (seed !== undefined) doc.channels = seed;
  writeFileSync(file, JSON.stringify(doc));
  const steps = [];
  for (const patch of PATCHES) {
    const next = await admin.setWebhookConfigAsync(patch);
    const saved = JSON.parse(readFileSync(file, 'utf8'));
    steps.push({ patch, returned: next, channels: saved.channels ?? null });
  }
  process.stdout.write(JSON.stringify({ seed: seed === undefined ? null : seed, seeded: seed !== undefined, steps }));
  process.exit(0);
}

const root = mkdtempSync(join(tmpdir(), 'rec-channel-settings-'));
const cases = [];
for (const seedName of Object.keys(SEEDS)) {
  const stdout = execFileSync(process.execPath, [process.argv[1], '--tree', tree, '--seed', seedName, '--home', join(root, seedName)], { encoding: 'utf8', maxBuffer: 1 << 24 });
  cases.push({ name: seedName, ...JSON.parse(stdout) });
}
writeFileSync(out, JSON.stringify({ node: process.version, cases }, null, 1));
rmSync(root, { recursive: true, force: true });
