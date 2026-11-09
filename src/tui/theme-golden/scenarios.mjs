// The config states the boot theme is read in, recorded from Node (b6f10295a `readConfig()`) into
// node-theme.golden.json by record.mjs and replayed against theme-config.mjs by theme.test.mjs.
//
// Branches of user-data-guard.mjs (:174-441, every `||`/`&&` alternative) and the state that records each:
//   getBackupRoot / legacyBackupRoots   MIXDOG_USER_DATA_BACKUP_ROOT set ........ default layout (every state)
//                                       MIXDOG_HOME set, CONFIG_DIR differs ..... 'legacy backups of both roots…', 'initialized … only … current root'
//                                       only MIXDOG_CONFIG_DIR ................... 'the backup root under MIXDOG_CONFIG_DIR alone'
//                                       neither: the home directory .............. 'the backup root under the home directory…'
//                                       legacy root equals / differs from current  single-root states / both-roots states
//   readInitInstanceId                  absent (ENOENT) ......................... fresh and marker-less states
//                                       unreadable (folder) ..................... 'an init marker that is a folder…'
//                                       JSON damaged ............................ 'a damaged init marker…'
//                                       no / empty / non-text instanceId ........ three 'an init marker … instanceId' states
//   legacyMarkersFor                    hashed name, or named by contents ....... 'a legacy marker in the legacy root…', '…found by the data dir it names'
//                                       root missing / unreadable ............... states whose legacy root has no folder
//                                       a marker naming another dir / damaged ... no effect on selection: markers only make evidence, and evidence
//                                                                                 without a restorable backup restores nothing ('a legacy marker without a backup…')
//   findLegacyUserDataEvidence          scoped backups exist → null ............. 'a marker-less data dir with scoped backups…'
//                                       scope-* folders of other dirs skipped ... "…scope folder in the root is skipped by the legacy scan"
//                                       manifest names this dir / another / none  'a legacy unscoped backup naming…', 'a legacy backup that names another…',
//                                                                                 'a legacy backup without a manifest…'
//                                       markers or backups (either alternative) . marker-only and backup-only states
//                                       backups ordered by name, ties by root ... 'legacy backups of both roots…' (newest wins, same name: current root)
//   isUserDataRecoveryExpected          marker / legacy evidence / neither ...... marker states / legacy states / fresh states
//   isStructurallyComplete              not an object (array) ................... 'an incomplete newest scoped backup falls through…'
//                                       one key or fewer ........................ 'the newest backup is a single-section remnant…'
//                                       agent only / channels only .............. 'a config with only agent and ui…', 'a backup with channels but no agent…'
//                                       agent and channels both falsy ........... 'a backup whose agent and channels are both empty values…'
//   isAbsentBackupError / list…         SyntaxError, ENOENT, ENOTDIR → absent ... damaged config/manifest, missing config, 'a scope path that is a file…'
//                                       any other error → throws ................ 'an unreadable newest backup config…', 'an unreadable manifest…'
//                                       entries that are not folders ignored .... 'a plain file among the backup folders…'
//                                       names sorted as text, newest first ....... 'backup names sort as text…'
//   readRestorableConfig                dataDir not text / other dir ............ 'a manifest without a data dir…', 'a backup that names another data dir…'
//                                       instanceId differs / missing ............ 'a backup of another incarnation…', '…manifest lacks the incarnation…'
//                                       config complete / incomplete ............ see isStructurallyComplete
//   findRestorableConfig                scope folder first, then root entries ... 'a scoped backup wins over a newer unscoped one'
//                                       root entries named scope-* skipped ...... "…scope folder in the root is never searched…"
//   loadLatestMixdogConfigFromBackup    marker → scoped lookup, else legacy ..... marker states / legacy states
//   loadLegacyMixdogConfigFromBackup    damaged or unreadable config skipped .... 'a legacy backup with a damaged / an unreadable config…'
//                                       incomplete skipped ...................... 'a legacy backup that is incomplete…'
// Not recordable here: win32 lower-casing of the data dir key (normalizeDataDir) — the recording and the replay run on the
// same platform, so both take the same branch — and the per-process lookup cache (a TUI boot reads once).
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
  if (scenario.layout === 'config-dir') {
    // Only MIXDOG_CONFIG_DIR is set: it is both the current and the legacy root's home.
    const home = join(base, 'cfg');
    const root = join(home, 'backups', 'user-data');
    return { backupRoot: root, legacyRoot: root, env: { MIXDOG_CONFIG_DIR: home }, unset: ['MIXDOG_HOME', 'MIXDOG_USER_DATA_BACKUP_ROOT'] };
  }
  if (scenario.layout === 'homedir') {
    // Nothing is set: both roots are under the user's home directory.
    const user = join(base, 'user');
    const root = join(user, '.mixdog', 'backups', 'user-data');
    return {
      backupRoot: root,
      legacyRoot: root,
      env: { USERPROFILE: user, HOME: user },
      unset: ['MIXDOG_HOME', 'MIXDOG_CONFIG_DIR', 'MIXDOG_USER_DATA_BACKUP_ROOT'],
    };
  }
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
  // Completeness of a backup (`isStructurallyCompleteMixdogConfigBackup`: an object with two keys or more, and agent or channels).
  {
    name: 'a backup with channels but no agent counts as complete',
    setup: ({ dataDir, backupRoot }) => {
      put(join(dataDir, MARKER), { instanceId: 'inst-1' });
      backup(scopeDir(dataDir, backupRoot), NAME_NEW, { dataDir, instanceId: 'inst-1', config: { channels: {}, ui: { theme: 'nord' } } });
    },
  },
  {
    name: 'a backup whose agent and channels are both empty values is incomplete',
    setup: ({ dataDir, backupRoot }) => {
      put(join(dataDir, MARKER), { instanceId: 'inst-1' });
      const scope = scopeDir(dataDir, backupRoot);
      backup(scope, NAME_OLD, { dataDir, instanceId: 'inst-1', config: complete('gruvbox') });
      backup(scope, NAME_NEW, { dataDir, instanceId: 'inst-1', config: { agent: null, channels: 0, ui: { theme: 'dracula' } } });
    },
  },
  {
    name: 'a legacy backup that is incomplete is skipped for the next legacy one',
    setup: ({ dataDir, backupRoot }) => {
      backup(backupRoot, NAME_OLD, { dataDir, config: complete('rosepine') });
      backup(backupRoot, NAME_NEW, { dataDir, config: { ui: { theme: 'dracula' } } });
    },
  },
  // The init marker (`readInitInstanceId`).
  {
    name: 'an init marker that is a folder makes the read fail',
    setup: ({ dataDir, backupRoot }) => {
      mkdirSync(join(dataDir, MARKER), { recursive: true });
      backup(scopeDir(dataDir, backupRoot), NAME_NEW, { dataDir, instanceId: 'inst-1', config: complete('dracula') });
    },
  },
  {
    name: 'an init marker without an instanceId makes the read fail',
    setup: ({ dataDir }) => put(join(dataDir, MARKER), {}),
  },
  {
    name: 'an init marker with an empty instanceId makes the read fail',
    setup: ({ dataDir }) => put(join(dataDir, MARKER), { instanceId: '' }),
  },
  {
    name: 'an init marker with a non-text instanceId makes the read fail',
    setup: ({ dataDir }) => put(join(dataDir, MARKER), { instanceId: 7 }),
  },
  // Scope folders and entries of the backup root.
  {
    name: "another data dir's scope folder in the root is never searched for an initialized data dir",
    setup: ({ dataDir, backupRoot }) => {
      put(join(dataDir, MARKER), { instanceId: 'inst-1' });
      backup(join(backupRoot, 'scope-0123456789abcdef'), NAME_NEW, { dataDir, instanceId: 'inst-1', config: complete('dracula') });
    },
  },
  {
    name: "another data dir's scope folder in the root is skipped by the legacy scan",
    setup: ({ dataDir, backupRoot }) => {
      backup(join(backupRoot, 'scope-0123456789abcdef'), NAME_NEW, { dataDir, config: complete('dracula') });
      backup(backupRoot, NAME_OLD, { dataDir, config: complete('rosepine') });
    },
  },
  {
    name: 'a legacy backup without a manifest is never restored',
    setup: ({ dataDir, backupRoot }) => put(join(backupRoot, NAME_NEW, CONFIG), complete('dracula')),
  },
  {
    name: 'a manifest without a data dir is not restorable',
    setup: ({ dataDir, backupRoot }) => {
      put(join(dataDir, MARKER), { instanceId: 'inst-1' });
      put(join(scopeDir(dataDir, backupRoot), NAME_NEW, 'backup.json'), { instanceId: 'inst-1' });
      put(join(scopeDir(dataDir, backupRoot), NAME_NEW, CONFIG), complete('dracula'));
    },
  },
  {
    name: 'a plain file among the backup folders is not a backup',
    setup: ({ dataDir, backupRoot }) => {
      put(join(dataDir, MARKER), { instanceId: 'inst-1' });
      const scope = scopeDir(dataDir, backupRoot);
      put(join(scope, '2026-03-01T00-00-00-000Z-0000000003-file'), 'not a backup folder');
      backup(scope, NAME_OLD, { dataDir, instanceId: 'inst-1', config: complete('gruvbox') });
    },
  },
  // Where the backup root comes from.
  {
    name: 'the backup root under MIXDOG_CONFIG_DIR alone',
    layout: 'config-dir',
    setup: ({ dataDir, backupRoot }) => {
      put(join(dataDir, MARKER), { instanceId: 'inst-1' });
      backup(scopeDir(dataDir, backupRoot), NAME_NEW, { dataDir, instanceId: 'inst-1', config: complete('dracula') });
    },
  },
  {
    name: 'the backup root under the home directory when nothing is set',
    layout: 'homedir',
    setup: ({ dataDir, backupRoot }) => {
      put(join(dataDir, MARKER), { instanceId: 'inst-1' });
      backup(scopeDir(dataDir, backupRoot), NAME_NEW, { dataDir, instanceId: 'inst-1', config: complete('dracula') });
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
