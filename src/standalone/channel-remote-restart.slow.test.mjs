// Remote ON survives the daemon's death: the real daemon in an isolated home,
// data dir and runtime root is killed by pid and its replacement is started the
// way the desktop launcher starts it (session-spawned: the channels side stays
// dormant until a channels client registers, as the desktop's does).
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { basename } from 'node:path';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { isPidAlive } from '../runtime/shared/pid-liveness.mjs';
import { ensureDaemon } from './session-client.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-remote-restart-'));
  const home = join(root, 'home');
  const dataDir = join(home, '.mixdog', 'data');
  mkdirSync(dataDir, { recursive: true });
  const env = {
    MIXDOG_DATA_DIR: dataDir,
    MIXDOG_HOME: join(home, '.mixdog'),
    MIXDOG_RUNTIME_ROOT: join(root, 'runtime'),
    MIXDOG_DAEMON_SKIP_MEMORY: '1',
    MIXDOG_RELAY_URL: 'off',
    HOME: home,
    USERPROFILE: home,
  };
  const previous = Object.fromEntries(Object.keys(env).map((name) => [name, process.env[name]]));
  const previousExecArgv = process.execArgv;
  Object.assign(process.env, env);
  process.execArgv = [];
  const pids = new Set();
  t.after(async () => {
    for (const pid of pids) {
      try {
        process.kill(pid);
      } catch {}
      for (let i = 0; i < 100 && isPidAlive(pid); i += 1) await delay(50);
    }
    // The daemon's PostgreSQL (started by the bridge) outlives its kill and keeps the fixture busy; it is
    // found by the fixture's unique directory name, so only this test's processes are touched.
    const marker = basename(root);
    if (process.platform === 'win32') {
      spawnSync('powershell', ['-NoProfile', '-Command', `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*${marker}*' -and $_.ProcessId -ne $PID } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`]);
    } else spawnSync('pkill', ['-f', marker]);
    await delay(1500);
    process.execArgv = previousExecArgv;
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await rm(root, { recursive: true, force: true, maxRetries: 40, retryDelay: 100 });
  });
  return {
    root,
    logPath: join(dataDir, 'daemon.log'),
    intentPath: join(root, 'runtime', 'channel-remote-intent.json'),
    bridgePath: join(root, 'runtime', 'bridge-state.json'),
    discoveryPath: join(root, 'runtime', 'daemon.json'),
    track: (pid) => pids.add(Number(pid)),
    log: () => (existsSync(join(dataDir, 'daemon.log')) ? readFileSync(join(dataDir, 'daemon.log'), 'utf8') : ''),
    bridgeActive: () => JSON.parse(readFileSync(join(root, 'runtime', 'bridge-state.json'), 'utf8')).active,
  };
}

async function waitFor(predicate, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await delay(50);
  }
  return predicate();
}

async function post(fx, path, body) {
  const { port, token } = JSON.parse(readFileSync(fx.discoveryPath, 'utf8')).endpoints.channel;
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-mixdog-daemon-token': token },
    body: JSON.stringify(body),
  });
  const value = await response.json();
  assert.ok(response.ok, JSON.stringify(value));
  return value;
}

async function startDaemon(fx) {
  const discovery = await ensureDaemon({ cwd: fx.root, attempts: 2, readyTimeoutMs: 60_000 });
  fx.track(discovery.pid);
  return Number(discovery.pid);
}

async function remote(fx, active, sessionId, transcriptPath) {
  const client = await post(fx, '/client/register', { leadPid: process.pid, cwd: fx.root, passive: true });
  await post(fx, '/call', {
    token: client.token,
    name: 'activate_channel_bridge',
    args: { active, sessionId, transcriptPath },
  });
}

async function killHard(pid) {
  process.kill(pid, 'SIGKILL');
  assert.ok(await waitFor(() => !isPidAlive(pid), 15_000), 'the daemon died');
}

// What the desktop does once it reaches the replacement: a channels client
// registers, which starts the deferred channels runtime.
async function desktopReconnects(fx) {
  await post(fx, '/client/register', { leadPid: process.pid, cwd: fx.root, passive: true });
  // The deferred start is over when the daemon says so; a Remote it resets shows by then.
  assert.ok(
    await waitFor(() => fx.log().includes('channels runtime started'), 60_000),
    `the replacement's channels runtime did not finish starting within 60 s:\n${fx.log()}`
  );
}

test('Remote ON survives a hard kill: the replacement has it ON for the same session, no user action', async (t) => {
  const fx = fixture(t);
  const transcriptPath = join(fx.root, 'session_real.jsonl');
  writeFileSync(transcriptPath, '');
  const first = await startDaemon(fx);
  await remote(fx, true, 'session_real', transcriptPath);
  assert.equal(JSON.parse(readFileSync(fx.intentPath, 'utf8')).sessionId, 'session_real');
  assert.equal(fx.bridgeActive(), true);

  await killHard(first);
  const second = await startDaemon(fx);
  assert.notEqual(second, first);
  assert.ok(await waitFor(() => fx.log().includes('remote intent restored session=session_real')), fx.log());
  await desktopReconnects(fx);
  assert.equal(fx.bridgeActive(), true, 'the late channels start must not switch the restored Remote off');
  assert.equal(JSON.parse(readFileSync(fx.intentPath, 'utf8')).sessionId, 'session_real');
});

test('Remote OFF stays OFF across a hard kill and replacement', async (t) => {
  const fx = fixture(t);
  const transcriptPath = join(fx.root, 'session_off.jsonl');
  writeFileSync(transcriptPath, '');
  const first = await startDaemon(fx);
  await remote(fx, true, 'session_off', transcriptPath);
  await remote(fx, false, 'session_off', transcriptPath);
  assert.equal(existsSync(fx.intentPath), false);

  await killHard(first);
  await startDaemon(fx);
  await desktopReconnects(fx);
  assert.equal(fx.bridgeActive(), false);
  assert.ok(!fx.log().includes('remote intent restored'));
});

test('a Remote whose session is gone is declined once and the pin dropped', async (t) => {
  const fx = fixture(t);
  const transcriptPath = join(fx.root, 'session_gone.jsonl');
  writeFileSync(transcriptPath, '');
  const first = await startDaemon(fx);
  await remote(fx, true, 'session_gone', transcriptPath);
  await killHard(first);
  rmSync(transcriptPath);

  await startDaemon(fx);
  assert.ok(await waitFor(() => fx.log().includes('remote intent restore declined (session unavailable)')), fx.log());
  assert.equal(existsSync(fx.intentPath), false);
  await desktopReconnects(fx);
  assert.equal(fx.bridgeActive(), false);
});




