import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { createSessionApi } from '../tui/session/session-api.mjs';
import { createSettingsApi } from './settings-api.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const T0 = Date.UTC(2026, 0, 1, 9);
const MINUTE = 60_000;

/** Runs `source` in a fresh node process over an empty data dir, as the config tests do:
 *  the config file, its loader and its saver are the real ones. */
function runIsolated(prefix, source) {
  const dataDir = mkdtempSync(join(tmpdir(), prefix));
  try {
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', source], {
      cwd: repoRoot,
      env: {
        ...process.env,
        MIXDOG_DATA_DIR: dataDir,
        MIXDOG_CONFIG_READ_TTL_MS: '0',
        MIXDOG_USER_DATA_BACKUP_ROOT: join(dataDir, 'backups'),
      },
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
}

test('the heartbeat setting end to end over the real config file: setup, stored key, status, settings read, and the tick', () => {
  runIsolated(
    'mixdog-heartbeat-setting-',
    `
    import assert from 'node:assert/strict';
    import { existsSync, readFileSync } from 'node:fs';
    import { join } from 'node:path';
    import { loadConfig, saveConfig } from './src/runtime/agent/orchestrator/config.mjs';
    import { createSettingsApi } from './src/session-runtime/settings-api.mjs';
    import { createSetupToolExecutor } from './src/session-runtime/setup-tool/executor.mjs';
    import { createMixyHeartbeat } from './src/session-runtime/mixy-heartbeat.mjs';

    const dir = process.env.MIXDOG_DATA_DIR;
    const configPath = join(dir, 'mixdog-config.json');
    const stored = () => (existsSync(configPath) ? JSON.parse(readFileSync(configPath, 'utf8')).agent ?? {} : {});
    const api = createSettingsApi({
      getConfig: () => loadConfig({ secrets: false }),
      saveConfigAndAdopt: (next) => saveConfig(next),
    });
    const setup = async (args, facade = api) =>
      JSON.parse(
        await createSetupToolExecutor({ getApi: () => facade, getConfig: () => loadConfig({ secrets: false }) }).execute(args, {})
      );
    const features = async () => (await setup({ action: 'status', domain: 'features' }, {})).heartbeat;

    const HOUR = 3_600_000;
    let clock = Date.UTC(2026, 0, 1, 9);
    const calls = { collect: 0, decide: 0, wake: 0 };
    // Everything but the enabled check is a fake; the check is the default: the real config.
    const heartbeat = createMixyHeartbeat({
      now: () => clock,
      path: join(dir, 'heartbeat.json'),
      userTurnAt: () => 0,
      collect: async () => {
        calls.collect += 1;
        return { sessions: [{ id: 'sess_lead_a', bot: '', title: 'Taxes', preview: 'Filed' }], tasks: [], approvals: 0, routines: [] };
      },
      routeKey: async () => 'fake/tiny/',
      decide: async () => {
        calls.decide += 1;
        return { action: 'nothing' };
      },
      wake: async () => {
        calls.wake += 1;
        return { quiet: true };
      },
      notify: async () => {},
      log: () => {},
    });

    // Another stored setting must survive every toggle.
    saveConfig({ ...loadConfig({ secrets: false }), profile: { title: 'Kept', language: 'ko' } });

    // Default: on, nothing stored.
    assert.equal(loadConfig({ secrets: false }).heartbeat, true);
    assert.equal(Object.hasOwn(stored(), 'heartbeat'), false);
    assert.deepEqual(api.getHeartbeatSettings(), { heartbeat: true });
    assert.deepEqual(await features(), { enabled: true });
    assert.equal(await heartbeat.tick(), 'armed');
    clock += 2 * HOUR;

    // Off through the setup tool.
    const off = await setup({ action: 'set_heartbeat_enabled', enabled: false });
    assert.equal(off.heartbeat, false);
    assert.equal(stored().heartbeat, false, 'only the opt-out is stored');
    assert.equal(loadConfig({ secrets: false }).heartbeat, false);
    assert.deepEqual(await features(), { enabled: false });
    assert.deepEqual(api.getHeartbeatSettings(), { heartbeat: false });
    assert.equal(stored().profile.title, 'Kept');
    for (let step = 0; step < 6; step += 1) {
      clock += 2 * HOUR;
      assert.equal(await heartbeat.tick(), 'off');
    }
    assert.deepEqual(calls, { collect: 0, decide: 0, wake: 0 }, 'off: nothing is collected, asked or woken');

    // A refused value changes nothing.
    await assert.rejects(setup({ action: 'set_heartbeat_enabled', enabled: 'no' }), /boolean/);
    await assert.rejects(setup({ action: 'set_heartbeat_enabled' }), /enabled is required/);
    assert.equal(stored().heartbeat, false);

    // On again: the key is gone, the check runs at its next tick.
    const on = await setup({ action: 'set_heartbeat_enabled', enabled: true });
    assert.equal(on.heartbeat, true);
    assert.equal(Object.hasOwn(stored(), 'heartbeat'), false, 'turning it on removes the stored key');
    assert.deepEqual(await features(), { enabled: true });
    assert.deepEqual(api.getHeartbeatSettings(), { heartbeat: true });
    assert.equal(stored().profile.title, 'Kept');
    assert.equal(await heartbeat.tick(), 'nothing');
    assert.deepEqual(calls, { collect: 1, decide: 1, wake: 0 });
    `
  );
});

test('the session surface forwards the heartbeat setting, and reads on when the runtime does not know it', async () => {
  let config = {};
  const settings = createSettingsApi({
    getConfig: () => config,
    saveConfigAndAdopt: (next) => {
      config = next;
    },
  });
  const bag = (runtime) =>
    new Proxy(
      {},
      {
        get: (_target, key) => {
          if (key === 'runtime') return runtime;
          if (key === 'flags') return {};
          if (key === 'listeners') return new Set();
          if (key === 'pending') return [];
          return () => ({});
        },
        has: () => true,
      }
    );
  const api = createSessionApi(bag(settings));
  assert.deepEqual(api.getHeartbeatSettings(), { heartbeat: true });
  assert.deepEqual(await api.setHeartbeatEnabled(false), { heartbeat: false });
  assert.equal(config.heartbeat, false);
  assert.deepEqual(api.getHeartbeatSettings(), { heartbeat: false });
  assert.deepEqual(await api.setHeartbeatEnabled(true), { heartbeat: true });
  assert.deepEqual(api.getHeartbeatSettings(), { heartbeat: true });
  // Only a literal true turns it on: the setter never guesses from a truthy value.
  assert.deepEqual(settings.setHeartbeatEnabled('yes'), { heartbeat: false });
  // A runtime without the setting reads as on.
  assert.deepEqual(createSessionApi(bag({})).getHeartbeatSettings(), { heartbeat: true });
});

// In its own process: noteUserTurn moves a process-wide time that only grows.
test('the daemon timers run the check: first tick after a minute arms, a turn the user just sent defers a due check', () => {
  runIsolated(
    'mixdog-heartbeat-timers-',
    `
  import assert from 'node:assert/strict';
  import { existsSync, readFileSync } from 'node:fs';
  import { join } from 'node:path';
  import { HEARTBEAT_LIMITS, noteUserTurn, startMixyHeartbeat } from './src/session-runtime/mixy-heartbeat.mjs';

  const T0 = ${T0};
  const MINUTE = ${MINUTE};
  const path = join(process.env.MIXDOG_DATA_DIR, 'heartbeat.json');
  let clock = T0;
  let collects = 0;
  const timers = {
    callbacks: [],
    setTimeout(fn, ms) {
      this.callbacks.push(['timeout', ms, fn]);
      return { unref() {} };
    },
    setInterval(fn, ms) {
      this.callbacks.push(['interval', ms, fn]);
      return { unref() {} };
    },
    clearTimeout() {},
    clearInterval() {},
  };
  const stop = startMixyHeartbeat({
    timers,
    now: () => clock,
    path,
    isEnabled: async () => true,
    collect: async () => {
      collects += 1;
      return { sessions: [{ id: 'sess_lead_a', bot: '', title: 'T', preview: 'p' }], tasks: [], approvals: 0, routines: [] };
    },
    routeKey: async () => '',
    decide: async () => ({ action: 'nothing' }),
    wake: async () => ({ quiet: true }),
    notify: async () => {},
    log: () => {},
  });
  const [[, firstMs, first], [, everyMs, every]] = timers.callbacks;
  assert.deepEqual([firstMs, everyMs], [HEARTBEAT_LIMITS.firstTickMs, HEARTBEAT_LIMITS.tickMs]);
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  assert.equal(existsSync(path), false);
  first();
  await settle();
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).lastBeatAt, T0, 'the first tick arms the clock');
  // Interval ticks before the interval is up do nothing; the user's turn then defers the due check.
  clock = T0 + 5 * MINUTE;
  every();
  await settle();
  assert.equal(collects, 0);
  clock = T0 + HEARTBEAT_LIMITS.intervalMs;
  noteUserTurn(clock - 5 * MINUTE);
  every();
  await settle();
  assert.equal(collects, 0, 'a turn 5 minutes ago: the check waits');
  clock += 5 * MINUTE;
  every();
  await settle();
  assert.equal(collects, 1, 'the user has been quiet for 10 minutes: the check runs');
  stop();
  `
  );
});
