// The config states the boot theme is read in, recorded from Node (b6f10295a `readConfig()`) into
// node-theme.golden.json by record.mjs and replayed against theme-config.mjs by theme.test.mjs.
// `setup({ dataDir, backupRoot })` builds the state (backup paths depend on the data dir, so they are built per run).
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const CONFIG = 'mixdog-config.json';
const MARKER = '.mixdog-user-data.json';
const complete = (theme) => ({ agent: { presets: [] }, ui: { theme }, channels: {} });

const put = (file, content) => {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content));
};
const normalized = (dataDir) => {
  const full = resolve(dataDir);
  return process.platform === 'win32' ? full.toLowerCase() : full;
};
const scopeDir = (dataDir, backupRoot) =>
  join(backupRoot, `scope-${createHash('sha256').update(normalized(dataDir)).digest('hex').slice(0, 16)}`);
const backup = (dir, name, { dataDir, instanceId, config }) => {
  put(join(dir, name, 'backup.json'), { dataDir, ...(instanceId ? { instanceId } : {}) });
  put(join(dir, name, CONFIG), config);
};
const NAME_OLD = '2026-01-01T00-00-00-000Z-0000000001-pre-config-write';
const NAME_NEW = '2026-02-01T00-00-00-000Z-0000000002-post-config-write';

export const SCENARIOS = [
  { name: 'a readable config names the theme', setup: ({ dataDir }) => put(join(dataDir, CONFIG), { ui: { theme: 'nord' } }) },
  { name: 'a config with a byte order mark', setup: ({ dataDir }) => put(join(dataDir, CONFIG), `\ufeff${JSON.stringify({ ui: { theme: 'nord' } })}`) },
  { name: 'a config without ui has no theme', setup: ({ dataDir }) => put(join(dataDir, CONFIG), { agent: {} }) },
  { name: 'no config in a fresh data dir', setup: () => {} },
  { name: 'a malformed config in a fresh data dir', setup: ({ dataDir }) => put(join(dataDir, CONFIG), '{ broken') },
  {
    name: 'a missing config in an initialized data dir is restored from the newest complete backup',
    setup: ({ dataDir, backupRoot }) => {
      put(join(dataDir, MARKER), { instanceId: 'inst-1' });
      const scope = scopeDir(dataDir, backupRoot);
      backup(scope, NAME_OLD, { dataDir, instanceId: 'inst-1', config: complete('gruvbox') });
      backup(scope, NAME_NEW, { dataDir, instanceId: 'inst-1', config: complete('dracula') });
    },
  },
  {
    name: 'a malformed config in an initialized data dir is restored from the backup',
    setup: ({ dataDir, backupRoot }) => {
      put(join(dataDir, CONFIG), '{ broken');
      put(join(dataDir, MARKER), { instanceId: 'inst-1' });
      backup(scopeDir(dataDir, backupRoot), NAME_NEW, { dataDir, instanceId: 'inst-1', config: complete('dracula') });
    },
  },
  {
    name: 'a malformed config in an initialized data dir with no backup',
    setup: ({ dataDir }) => {
      put(join(dataDir, CONFIG), '{ broken');
      put(join(dataDir, MARKER), { instanceId: 'inst-1' });
    },
  },
  {
    name: 'the newest backup is a single-section remnant: the older complete one is used',
    setup: ({ dataDir, backupRoot }) => {
      put(join(dataDir, MARKER), { instanceId: 'inst-1' });
      const scope = scopeDir(dataDir, backupRoot);
      backup(scope, NAME_OLD, { dataDir, instanceId: 'inst-1', config: complete('gruvbox') });
      backup(scope, NAME_NEW, { dataDir, instanceId: 'inst-1', config: { ui: { theme: 'dracula' } } });
    },
  },
  {
    name: 'a backup of another incarnation of the data dir is not restored',
    setup: ({ dataDir, backupRoot }) => {
      put(join(dataDir, MARKER), { instanceId: 'inst-2' });
      backup(scopeDir(dataDir, backupRoot), NAME_NEW, { dataDir, instanceId: 'inst-1', config: complete('dracula') });
    },
  },
  {
    name: 'a backup that names another data dir is not restored',
    setup: ({ dataDir, backupRoot }) => {
      put(join(dataDir, MARKER), { instanceId: 'inst-1' });
      backup(scopeDir(dataDir, backupRoot), NAME_NEW, { dataDir: join(dataDir, 'other'), instanceId: 'inst-1', config: complete('dracula') });
    },
  },
  {
    name: 'an unscoped backup of the initialized data dir is used when its scope has none',
    setup: ({ dataDir, backupRoot }) => {
      put(join(dataDir, MARKER), { instanceId: 'inst-1' });
      backup(backupRoot, NAME_NEW, { dataDir, instanceId: 'inst-1', config: complete('kanagawa') });
    },
  },
  {
    name: 'a legacy unscoped backup naming a marker-less data dir is restored',
    setup: ({ dataDir, backupRoot }) => {
      put(join(dataDir, CONFIG), '{ broken');
      backup(backupRoot, NAME_NEW, { dataDir, config: complete('rosepine') });
    },
  },
  {
    name: 'a legacy marker without a backup restores nothing',
    setup: ({ dataDir, backupRoot }) => {
      put(join(backupRoot, `.initialized-${createHash('sha256').update(dataDir).digest('hex').slice(0, 16)}.json`), { dataDir });
    },
  },
  {
    name: 'a damaged init marker makes the read fail',
    setup: ({ dataDir, backupRoot }) => {
      put(join(dataDir, MARKER), '{ not json');
      backup(scopeDir(dataDir, backupRoot), NAME_NEW, { dataDir, instanceId: 'inst-1', config: complete('dracula') });
    },
  },
];
