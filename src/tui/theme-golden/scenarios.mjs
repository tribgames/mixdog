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
/**
 * Where a scenario's backups live and the environment that points at them. By default one root (the explicit
 * MIXDOG_USER_DATA_BACKUP_ROOT); with `roots` the current root (under MIXDOG_HOME) and the legacy one (under
 * MIXDOG_CONFIG_DIR) differ and neither is set explicitly.
 */
export function themeLayout(base, scenario) {
  if (scenario.roots) {
    const current = join(base, 'home-current');
    const legacy = join(base, 'home-legacy');
    return {
      backupRoot: join(current, 'backups', 'user-data'),
      legacyRoot: join(legacy, 'backups', 'user-data'),
      env: { MIXDOG_HOME: current, MIXDOG_CONFIG_DIR: legacy },
      unset: ['MIXDOG_USER_DATA_BACKUP_ROOT'],
    };
  }
  const backupRoot = join(base, 'backups');
  return {
    backupRoot,
    legacyRoot: backupRoot,
    env: { MIXDOG_HOME: join(base, 'home'), MIXDOG_CONFIG_DIR: join(base, 'home'), MIXDOG_USER_DATA_BACKUP_ROOT: backupRoot },
    unset: [],
  };
}

const NAME_OLD ='2026-01-01T00-00-00-000Z-0000000001-pre-config-write';
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
  // A profile without the in-dir marker that already has scoped backups is a migrated one: nothing is restored.
  {
    name: 'a marker-less data dir with scoped backups restores nothing, whatever else is on disk',
    setup: ({ dataDir, backupRoot }) => {
      backup(scopeDir(dataDir, backupRoot), NAME_NEW, { dataDir, instanceId: 'inst-1', config: complete('dracula') });
      backup(backupRoot, NAME_OLD, { dataDir, config: complete('gruvbox') });
    },
  },
  // Competing backups: the scope comes first whatever the ages, then the unscoped entries of the root.
  {
    name: 'a scoped backup wins over a newer unscoped one',
    setup: ({ dataDir, backupRoot }) => {
      put(join(dataDir, MARKER), { instanceId: 'inst-1' });
      backup(scopeDir(dataDir, backupRoot), NAME_OLD, { dataDir, instanceId: 'inst-1', config: complete('gruvbox') });
      backup(backupRoot, NAME_NEW, { dataDir, instanceId: 'inst-1', config: complete('dracula') });
    },
  },
  {
    name: 'an incomplete newest scoped backup falls through to the older scoped one, then to the unscoped',
    setup: ({ dataDir, backupRoot }) => {
      put(join(dataDir, MARKER), { instanceId: 'inst-1' });
      const scope = scopeDir(dataDir, backupRoot);
      backup(scope, NAME_NEW, { dataDir, instanceId: 'inst-1', config: { ui: { theme: 'dracula' }, other: 1 } });
      backup(scope, NAME_OLD, { dataDir, instanceId: 'inst-1', config: [1, 2, 3] });
      backup(backupRoot, NAME_NEW, { dataDir, instanceId: 'inst-1', config: complete('kanagawa') });
    },
  },
  {
    name: 'backup names sort as text: the later sequence number wins within a millisecond',
    setup: ({ dataDir, backupRoot }) => {
      put(join(dataDir, MARKER), { instanceId: 'inst-1' });
      const scope = scopeDir(dataDir, backupRoot);
      backup(scope, '2026-02-01T00-00-00-000Z-0000000002-a', { dataDir, instanceId: 'inst-1', config: complete('gruvbox') });
      backup(scope, '2026-02-01T00-00-00-000Z-0000000010-b', { dataDir, instanceId: 'inst-1', config: complete('dracula') });
    },
  },
  {
    name: 'a config with only agent and ui keys counts as complete',
    setup: ({ dataDir, backupRoot }) => {
      put(join(dataDir, MARKER), { instanceId: 'inst-1' });
      backup(scopeDir(dataDir, backupRoot), NAME_NEW, { dataDir, instanceId: 'inst-1', config: { agent: {}, ui: { theme: 'nord' } } });
    },
  },
  {
    name: 'a backup whose manifest lacks the incarnation is not restored for an initialized data dir',
    setup: ({ dataDir, backupRoot }) => {
      put(join(dataDir, MARKER), { instanceId: 'inst-1' });
      backup(backupRoot, NAME_NEW, { dataDir, config: complete('dracula') });
    },
  },
  // Backups that cannot be read.
  {
    name: 'a newest backup without a config file is skipped for the older one',
    setup: ({ dataDir, backupRoot }) => {
      put(join(dataDir, MARKER), { instanceId: 'inst-1' });
      const scope = scopeDir(dataDir, backupRoot);
      backup(scope, NAME_OLD, { dataDir, instanceId: 'inst-1', config: complete('gruvbox') });
      put(join(scope, NAME_NEW, 'backup.json'), { dataDir, instanceId: 'inst-1' });
    },
  },
  {
    name: 'a newest backup with a damaged config is skipped for the older one',
    setup: ({ dataDir, backupRoot }) => {
      put(join(dataDir, MARKER), { instanceId: 'inst-1' });
      const scope = scopeDir(dataDir, backupRoot);
      backup(scope, NAME_OLD, { dataDir, instanceId: 'inst-1', config: complete('gruvbox') });
      backup(scope, NAME_NEW, { dataDir, instanceId: 'inst-1', config: '{ broken' });
    },
  },
  {
    name: 'an unreadable newest backup config ends the lookup: the older backup is not used',
    setup: ({ dataDir, backupRoot }) => {
      put(join(dataDir, MARKER), { instanceId: 'inst-1' });
      const scope = scopeDir(dataDir, backupRoot);
      backup(scope, NAME_OLD, { dataDir, instanceId: 'inst-1', config: complete('gruvbox') });
      put(join(scope, NAME_NEW, 'backup.json'), { dataDir, instanceId: 'inst-1' });
      mkdirSync(join(scope, NAME_NEW, CONFIG), { recursive: true }); // reading a folder fails with EISDIR
    },
  },
  {
    name: 'an unreadable manifest ends the lookup',
    setup: ({ dataDir, backupRoot }) => {
      put(join(dataDir, MARKER), { instanceId: 'inst-1' });
      const scope = scopeDir(dataDir, backupRoot);
      backup(scope, NAME_OLD, { dataDir, instanceId: 'inst-1', config: complete('gruvbox') });
      mkdirSync(join(scope, NAME_NEW, 'backup.json'), { recursive: true });
    },
  },
  {
    name: 'a scope path that is a file has no backups',
    setup: ({ dataDir, backupRoot }) => {
      put(join(dataDir, MARKER), { instanceId: 'inst-1' });
      put(scopeDir(dataDir, backupRoot), 'not a folder');
      backup(backupRoot, NAME_NEW, { dataDir, instanceId: 'inst-1', config: complete('kanagawa') });
    },
  },
  {
    name: 'a legacy backup with a damaged config is skipped for the next legacy one',
    setup: ({ dataDir, backupRoot }) => {
      backup(backupRoot, NAME_OLD, { dataDir, config: complete('rosepine') });
      backup(backupRoot, NAME_NEW, { dataDir, config: '{ broken' });
    },
  },
  {
    name: 'a legacy backup with an unreadable config is skipped for the next legacy one',
    setup: ({ dataDir, backupRoot }) => {
      backup(backupRoot, NAME_OLD, { dataDir, config: complete('rosepine') });
      put(join(backupRoot, NAME_NEW, 'backup.json'), { dataDir });
      mkdirSync(join(backupRoot, NAME_NEW, CONFIG), { recursive: true });
    },
  },
  // The current and the legacy backup root side by side (MIXDOG_HOME differs from MIXDOG_CONFIG_DIR).
  {
    name: 'legacy backups of both roots: the newest name wins whichever root holds it',
    roots: true,
    setup: ({ dataDir, backupRoot, legacyRoot }) => {
      backup(backupRoot, NAME_OLD, { dataDir, config: complete('gruvbox') });
      backup(legacyRoot, NAME_NEW, { dataDir, config: complete('dracula') });
    },
  },
  {
    name: 'legacy backups of both roots with the same name: the current root comes first',
    roots: true,
    setup: ({ dataDir, backupRoot, legacyRoot }) => {
      backup(legacyRoot, NAME_NEW, { dataDir, config: complete('dracula') });
      backup(backupRoot, NAME_NEW, { dataDir, config: complete('gruvbox') });
    },
  },
  {
    name: 'an initialized data dir looks only in the current root',
    roots: true,
    setup: ({ dataDir, legacyRoot }) => {
      put(join(dataDir, MARKER), { instanceId: 'inst-1' });
      backup(legacyRoot, NAME_NEW, { dataDir, instanceId: 'inst-1', config: complete('dracula') });
    },
  },
  {
    name: 'a legacy marker in the legacy root names the data dir, a backup in the current root is restored',
    roots: true,
    setup: ({ dataDir, backupRoot, legacyRoot }) => {
      put(join(legacyRoot, `.initialized-${createHash('sha256').update(resolve(dataDir)).digest('hex').slice(0, 16)}.json`), {});
      backup(backupRoot, NAME_NEW, { dataDir, config: complete('dracula') });
    },
  },
  {
    name: 'a legacy marker found by the data dir it names',
    setup: ({ dataDir, backupRoot }) => {
      put(join(backupRoot, '.initialized-someothername.json'), { dataDir });
      backup(backupRoot, NAME_NEW, { dataDir, config: complete('dracula') });
    },
  },
  {
    name: 'a legacy backup that names another data dir is ignored',
    setup: ({ dataDir, backupRoot }) => {
      put(join(backupRoot, '.initialized-x.json'), { dataDir });
      backup(backupRoot, NAME_NEW, { dataDir: join(dataDir, 'elsewhere'), config: complete('dracula') });
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
