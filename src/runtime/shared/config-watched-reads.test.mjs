// Section reads while the config directory is watched: served from memory
// until a watch event, for a present config and for a missing one on an
// initialized data dir (whose recovery check reads the init marker).
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { syncFsCalls } from './sync-fs-calls.fixture.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mixdog-config-watched-reads-'));
const dataDir = path.join(root, 'data');
fs.mkdirSync(dataDir);
const saved = new Map();
for (const [key, value] of Object.entries({
  MIXDOG_DATA_DIR: dataDir,
  MIXDOG_HOME: path.join(root, 'home'),
  MIXDOG_CONFIG_DIR: path.join(root, 'config'),
  MIXDOG_USER_DATA_BACKUP_ROOT: path.join(root, 'backups'),
})) {
  saved.set(key, process.env[key]);
  process.env[key] = value;
}
const config = await import('./config.mjs');
const guard = await import('./user-data-guard.mjs');
after(() => {
  for (const [key, value] of saved) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(root, { recursive: true, force: true });
});

const configFile = path.join(dataDir, 'mixdog-config.json');
const inDataDir = (calls) => calls.filter((call) => call.includes(dataDir));

/** The next listener pass of the config watch (another process's write). The
 *  watch is unref'd, so a never-firing timer holds the process until then. */
function nextChange() {
  const hold = setTimeout(() => {}, 60_000);
  return new Promise((resolve) => {
    const unsubscribe = config.subscribeConfigChange(() => {
      unsubscribe();
      clearTimeout(hold);
      resolve();
    });
  });
}

test('watched section reads touch no file until the config changes', async () => {
  guard.markUserDataInitialized(dataDir);
  const unsubscribe = config.subscribeConfigChange(() => {});
  try {
    // Missing config on an initialized dir: a loss with no backup, read as empty.
    assert.deepEqual(config.readSection('agent'), {});
    const missing = await syncFsCalls(() => {
      for (let i = 0; i < 20; i += 1) assert.deepEqual(config.readSection('agent'), {});
    });
    assert.deepEqual(inDataDir(missing), [], 'a missing config was re-checked on every read');

    let changed = nextChange();
    fs.writeFileSync(configFile, JSON.stringify({ agent: { title: 'one' } }));
    await changed;
    assert.equal(config.readSection('agent').title, 'one');
    const present = await syncFsCalls(() => {
      for (let i = 0; i < 20; i += 1) assert.equal(config.readSection('agent').title, 'one');
    });
    assert.deepEqual(inDataDir(present), [], 'a present config was stat-ed on every read');

    changed = nextChange();
    fs.writeFileSync(configFile, JSON.stringify({ agent: { title: 'two' } }));
    await changed;
    assert.equal(config.readSection('agent').title, 'two');
  } finally {
    unsubscribe();
  }
});

test('a replaced data dir ends the trust of reads from the old one', async () => {
  const unsubscribe = config.subscribeConfigChange(() => {});
  const moved = `${dataDir}-moved`;
  const waits = new Set();
  /** The first listener pass whose read of agent.title is `title`; rejects
   *  when none comes within 5 s (the watch never saw the change). */
  const titleSeen = (title) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        end();
        reject(new Error(`no config change pass read "${title}"`));
      }, 5000);
      const stop = config.subscribeConfigChange(() => {
        if (config.readSection('agent').title !== title) return;
        end();
        resolve();
      });
      const end = () => {
        stop();
        clearTimeout(timer);
        waits.delete(end);
      };
      waits.add(end);
    });
  try {
    let changed = nextChange();
    fs.writeFileSync(configFile, JSON.stringify({ agent: { title: 'old' } }));
    await changed;
    assert.equal(config.readSection('agent').title, 'old');

    // The watch stays on the moved directory; only the parent sees the swap.
    const seen = titleSeen('new');
    fs.renameSync(dataDir, moved);
    fs.mkdirSync(dataDir);
    fs.writeFileSync(configFile, JSON.stringify({ agent: { title: 'new' } }));
    await seen;
    assert.equal(config.readSection('agent').title, 'new');

    // Watched again, on the live directory.
    changed = titleSeen('newer');
    fs.writeFileSync(configFile, JSON.stringify({ agent: { title: 'newer' } }));
    await changed;
    const warm = await syncFsCalls(() => {
      for (let i = 0; i < 20; i += 1) assert.equal(config.readSection('agent').title, 'newer');
    });
    assert.deepEqual(inDataDir(warm), [], 'the re-armed watch is not trusted');
  } finally {
    for (const end of [...waits]) end();
    unsubscribe();
  }
});

test('a directory watch that closes on its own ends the trust at once', () => {
  const realWatch = config.configWatchDeps.watch;
  let watcher = null;
  config.configWatchDeps.watch = () => {
    watcher = Object.assign(new EventEmitter(), { close() {} });
    return watcher;
  };
  fs.writeFileSync(configFile, JSON.stringify({ agent: { title: 'before-close' } }));
  const unsubscribe = config.subscribeConfigChange(() => {});
  try {
    assert.equal(config.readSection('agent').title, 'before-close');
    watcher.emit('close');
    fs.writeFileSync(configFile, JSON.stringify({ agent: { title: 'after-close' } }));
    assert.equal(config.readSection('agent').title, 'after-close');
  } finally {
    unsubscribe();
    config.configWatchDeps.watch = realWatch;
  }
});

test('without a watch every read checks the file, as before', () => {
  fs.writeFileSync(configFile, JSON.stringify({ agent: { title: 'unwatched' } }));
  assert.equal(config.readSection('agent').title, 'unwatched');
  fs.writeFileSync(configFile, JSON.stringify({ agent: { title: 'unwatched-2' } }));
  assert.equal(config.readSection('agent').title, 'unwatched-2');
});
