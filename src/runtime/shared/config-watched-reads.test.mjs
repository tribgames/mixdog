// Section reads while the config directory is watched: served from memory
// until a watch event, for a present config and for a missing one on an
// initialized data dir (whose recovery check reads the init marker).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { configTimers } from './config-timers.fixture.mjs';
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
const writeTitle = (title) => fs.writeFileSync(configFile, JSON.stringify({ agent: { title } }));

// Where the platform hears a change from the moment a watch returns, reads
// under it wait for its event; elsewhere (macOS) every read checks the file,
// and the read that finds a change announces it.
const { vouches } = config.configWatchDeps;

/** Reads under the watch: where it vouches they touch no file of the data dir,
 *  elsewhere they check it. */
function assertWatchedReads(calls, message) {
  if (vouches) assert.deepEqual(inDataDir(calls), [], message);
  else assert.notDeepEqual(inDataDir(calls), [], 'a read under a watch that does not vouch checks the file');
}

/** The first listener pass that reads agent.title as `title`; rejects after 5 s. */
function titleSeen(title) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      stop();
      reject(new Error(`no config change pass read "${title}"`));
    }, 5000);
    const stop = config.subscribeConfigChange(() => {
      if (config.readSection('agent').title !== title) return;
      stop();
      clearTimeout(timer);
      resolve();
    });
  });
}

/** Another process writes `title` (by `write`), and the listener pass that
 *  reads it is awaited: where the watch vouches it comes on the watch's event,
 *  elsewhere on the read that finds the change. */
async function writeElsewhere(title, write = () => writeTitle(title)) {
  const seen = titleSeen(title);
  write();
  if (!vouches) config.readSection('agent');
  await seen;
  assert.equal(config.readSection('agent').title, title);
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
    assertWatchedReads(missing, 'a missing config was re-checked on every read');

    await writeElsewhere('one');
    const present = await syncFsCalls(() => {
      for (let i = 0; i < 20; i += 1) assert.equal(config.readSection('agent').title, 'one');
    });
    assertWatchedReads(present, 'a present config was stat-ed on every read');

    await writeElsewhere('two');
  } finally {
    unsubscribe();
  }
});

test('a replaced data dir ends the trust of reads from the old one', async () => {
  const unsubscribe = config.subscribeConfigChange(() => {});
  const moved = `${dataDir}-moved`;
  try {
    await writeElsewhere('old');

    // The watch stays on the moved directory; only the parent sees the swap.
    await writeElsewhere('new', () => {
      fs.renameSync(dataDir, moved);
      fs.mkdirSync(dataDir);
      writeTitle('new');
    });

    // Watched again, on the live directory.
    await writeElsewhere('newer');
    const warm = await syncFsCalls(() => {
      for (let i = 0; i < 20; i += 1) assert.equal(config.readSection('agent').title, 'newer');
    });
    assertWatchedReads(warm, 'the re-armed watch is not trusted');
  } finally {
    unsubscribe();
  }
});

const onlyDebounce = (delays) => delays.filter((ms) => ms !== 100);

/** Resolves when the config watch, ended, waits for the data dir to be named
 *  again in its parent; rejects after 5 s. */
function waitingForDataDir(t) {
  const real = config.configWatchDeps.watch;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('the ended config watch never waited for its directory')), 5000);
    t.mock.method(config.configWatchDeps, 'watch', (dir, names, handlers) => {
      const subscription = real(dir, names, handlers);
      if (dir === root && names.includes(path.basename(dataDir))) {
        clearTimeout(timer);
        resolve();
      }
      return subscription;
    });
  });
}

test('a config dir deleted and recreated is watched again on its parent’s event, with no timer but the debounce', async (t) => {
  const unsubscribe = config.subscribeConfigChange(() => {});
  try {
    await writeElsewhere('before-delete');
    const { delays } = configTimers(t, config);
    const waiting = vouches ? waitingForDataDir(t) : null;
    fs.rmSync(dataDir, { recursive: true, force: true });
    // The watch ends on the deletion before the folder is back.
    await waiting;
    await writeElsewhere('recreated', () => {
      fs.mkdirSync(dataDir);
      writeTitle('recreated');
    });
    assert.deepEqual(onlyDebounce(delays), [], 'only the change debounce was armed');
  } finally {
    unsubscribe();
  }
});

test('a config dir missing when the watch starts is watched once it is created, with no timer but the debounce', async (t) => {
  fs.rmSync(dataDir, { recursive: true, force: true });
  const { delays } = configTimers(t, config);
  const unsubscribe = config.subscribeConfigChange(() => {});
  try {
    await writeElsewhere('created', () => {
      fs.mkdirSync(dataDir);
      writeTitle('created');
    });
    assert.deepEqual(onlyDebounce(delays), [], 'only the change debounce was armed');
  } finally {
    unsubscribe();
    fs.mkdirSync(dataDir, { recursive: true });
  }
});

test('a watch that does not vouch (macOS) serves no read on its silence', () => {
  const real = { ...config.configWatchDeps };
  // Armed but not hearing yet: nothing it would report reaches the config.
  config.configWatchDeps.watch = () => ({ close() {}, trusted: true });
  config.configWatchDeps.vouches = false;
  writeTitle('before-unheard');
  const unsubscribe = config.subscribeConfigChange(() => {});
  try {
    assert.equal(config.readSection('agent').title, 'before-unheard');
    writeTitle('unheard');
    assert.equal(config.readSection('agent').title, 'unheard');
  } finally {
    unsubscribe();
    Object.assign(config.configWatchDeps, real);
  }
});

/** A watch that does not vouch and reports only what the test fires through
 *  the returned `event(name)`; restored when `t` ends. */
function silentWatch(t) {
  const handlers = [];
  t.mock.method(config.configWatchDeps, 'watch', (_dir, _names, { onEvent }) => {
    handlers.push(onEvent);
    return { close() {}, trusted: true };
  });
  const vouched = config.configWatchDeps.vouches;
  config.configWatchDeps.vouches = false;
  t.after(() => {
    config.configWatchDeps.vouches = vouched;
  });
  return (name) => handlers[0]('change', name);
}

test('where the watch does not vouch, a read that finds a change tells the listeners once', async (t) => {
  silentWatch(t);
  writeTitle('quiet');
  const seen = [];
  const unsubscribe = config.subscribeConfigChange(() => seen.push(config.readSection('agent').title));
  try {
    const { delays, fired } = configTimers(t, config);
    const told = fired();
    writeTitle('found-by-read');
    assert.equal(config.readSection('agent').title, 'found-by-read');
    await told;
    assert.deepEqual(seen, ['found-by-read']);
    assert.equal(config.readSection('agent').title, 'found-by-read');
    assert.deepEqual(delays, [100], 'the second read announced nothing more');
    assert.deepEqual(seen, ['found-by-read']);
  } finally {
    unsubscribe();
  }
});

test('where the watch does not vouch, a watch event and a read finding the same change announce it once', async (t) => {
  const event = silentWatch(t);
  writeTitle('quiet');
  const seen = [];
  const unsubscribe = config.subscribeConfigChange(() => seen.push(config.readSection('agent').title));
  try {
    const { delays, fired } = configTimers(t, config);
    // The event first, the read before its pass.
    let told = fired();
    writeTitle('heard-by-watch');
    event('mixdog-config.json');
    assert.equal(config.readSection('agent').title, 'heard-by-watch');
    await told;
    assert.deepEqual(seen, ['heard-by-watch']);
    // The read first, its pass done, then the platform's late event.
    told = fired();
    writeTitle('read-first');
    assert.equal(config.readSection('agent').title, 'read-first');
    await told;
    told = fired();
    event('mixdog-config.json');
    await told;
    assert.deepEqual(seen, ['heard-by-watch', 'read-first']);
    assert.equal(config.readSection('agent').title, 'read-first');
    assert.deepEqual(onlyDebounce(delays), []);
  } finally {
    unsubscribe();
  }
});

test('where the watch does not vouch, a change landing between a pass’s two looks at the file is announced by the next read', async (t) => {
  const event = silentWatch(t);
  writeTitle('steady');
  const seen = [];
  const unsubscribe = config.subscribeConfigChange(() => seen.push(config.readSection('agent').title));
  const realRead = fs.readFileSync;
  let land = false;
  // Another process's save lands right after the pass has read the watched bytes.
  fs.readFileSync = function readThenLand(file, ...rest) {
    const bytes = realRead.call(this, file, ...rest);
    if (land && String(file) === configFile && rest[0] === 'latin1') {
      land = false;
      writeTitle('landed-between');
    }
    return bytes;
  };
  syncBuiltinESMExports();
  try {
    const { delays, fired } = configTimers(t, config);
    assert.equal(config.readSection('agent').title, 'steady');
    land = true;
    let pass = fired();
    // A pass with nothing to do: its bytes are the ones from before the save.
    event('mixdog-config.json');
    await pass;
    assert.equal(land, false, 'the save landed inside the pass');
    assert.deepEqual(seen, []);
    const armed = delays.length;
    pass = fired();
    assert.equal(config.readSection('agent').title, 'landed-between');
    assert.equal(delays.length, armed + 1, 'the read announced the change');
    await pass;
    assert.deepEqual(seen, ['landed-between']);
  } finally {
    fs.readFileSync = realRead;
    syncBuiltinESMExports();
    unsubscribe();
  }
});

test('a directory watch that closes on its own ends the trust at once', () => {
  const realWatch = config.configWatchDeps.watch;
  let lost = null;
  config.configWatchDeps.watch = (_dir, _names, { onLost }) => {
    // The first is the config directory's; later ones wait for it.
    lost ??= onLost;
    return { close() {}, trusted: true };
  };
  fs.writeFileSync(configFile, JSON.stringify({ agent: { title: 'before-close' } }));
  const unsubscribe = config.subscribeConfigChange(() => {});
  try {
    assert.equal(config.readSection('agent').title, 'before-close');
    lost(new Error('watch closed'));
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
