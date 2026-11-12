// Starts the BUILT app (out/main) against a real `mixdogd`, with its window held off every display, and checks the boot
// diagnostics: the main process reached the core, the renderer finished its handshake, and no module failed to load.
// Needs `npm run build` and MIXDOGD_BIN (a built mixdogd). Everything the app writes goes under one throwaway folder.
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';

import electron from 'electron';

import { writeDevInstall } from '../../scripts/dev-core-install.mjs';
import { ortBinaryDir } from '../../scripts/core-layout.mjs';
import { waitUntil } from '../../../../src/runtime/shared/wait-until.test-support.mjs';

const require = createRequire(import.meta.url);

const APP_DIR = fileURLToPath(new URL('../../', import.meta.url));
const BOOT_DEADLINE_MS = 90_000;
const QUIT_DEADLINE_MS = 30_000;
const CORE_STOP_DEADLINE_MS = 30_000;
const MODULE_FAILURE = /Failed to fetch dynamically imported module|Cannot find module|ERR_MODULE_NOT_FOUND|Failed to resolve (?:import|module)|Unable to resolve module|Loading chunk .* failed/i;

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
};

const readJson = (path) => {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
};

/** The processes whose command line names `folder`: what the app and its core left running there. */
async function processesNaming(folder) {
  const script = `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*${folder.replace(/'/g, "''")}*' -and $_.ProcessId -ne $PID } | ForEach-Object { "$($_.ProcessId)\`t$($_.Name)\`t$($_.CommandLine)" }`;
  const { stdout } = await promisify(execFile)('powershell', ['-NoProfile', '-Command', script], { windowsHide: true, timeout: 30_000 });
  return stdout.split('\n').map((line) => line.trim()).filter(Boolean).map((line) => {
    const [pid, name, commandLine] = line.split('\t');
    return { pid: Number(pid), name, commandLine: commandLine?.slice(0, 300) };
  });
}
function readEvents(path) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return [];
  }
  return text.split('\n').filter(Boolean).flatMap((line) => {
    try {
      return [JSON.parse(line)];
    } catch {
      return [];
    }
  });
}

test(
  'the built app starts against mixdogd with its window held off every display, the renderer is ready and no module fails to load',
  { timeout: 240_000, skip: process.platform !== 'win32' && 'Windows only' },
  async () => {
    const bin = process.env.MIXDOGD_BIN;
    assert.ok(bin && existsSync(bin), `MIXDOGD_BIN must name a built mixdogd (got ${JSON.stringify(bin)})`);
    assert.ok(existsSync(join(APP_DIR, 'out', 'main', 'index.js')), `the app is not built: run "npm run build" in ${APP_DIR}`);

    const root = await mkdtemp(join(tmpdir(), 'mixdog-app-start-'));
    const home = join(root, 'home');
    const dataDir = join(root, 'data');
    const runtimeRoot = join(root, 'runtime');
    const userData = join(root, 'user-data');
    const temp = join(root, 'tmp');
    const installDir = join(root, 'core');
    for (const dir of [home, dataDir, runtimeRoot, userData, temp, installDir]) await mkdir(dir, { recursive: true });
    const coreBin = join(installDir, 'mixdogd.exe');
    await copyFile(bin, coreBin);
    await writeDevInstall({
      exe: coreBin,
      ortLibrary: join(dirname(require.resolve('onnxruntime-node/package.json')), ortBinaryDir('win32', 'x64'), 'onnxruntime.dll'),
    });
    const diagnosticsPath = join(userData, 'logs', 'desktop-diagnostics.jsonl');
    const discoveryPath = join(runtimeRoot, 'daemon.json');
    const env = {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      APPDATA: join(home, 'AppData', 'Roaming'),
      LOCALAPPDATA: join(home, 'AppData', 'Local'),
      TEMP: temp,
      TMP: temp,
      MIXDOG_HOME: join(home, '.mixdog'),
      MIXDOG_DATA_DIR: dataDir,
      MIXDOG_RUNTIME_ROOT: runtimeRoot,
      MIXDOG_DESKTOP_USER_DATA: userData,
      MIXDOG_DESKTOP_HIDDEN_WINDOW: '1',
      MIXDOG_BOOT_SCENARIO: 'app-start-check',
      MIXDOGD_BIN: coreBin,
    };
    delete env.ELECTRON_RUN_AS_NODE;

    let app = null;
    let output = '';
    let exit = null;
    let corePid = null;
    let finished = false;
    try {
      assert.ok(!existsSync(discoveryPath), 'the throwaway runtime root must start without a core');
      app = spawn(electron, [APP_DIR], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      app.stdout.setEncoding('utf8').on('data', (chunk) => (output += chunk));
      app.stderr.setEncoding('utf8').on('data', (chunk) => (output += chunk));
      app.once('exit', (code, signal) => (exit = { code, signal }));
      const evidence = () => `\n--- app output ---\n${output.slice(-4000)}\n--- events ---\n${readEvents(diagnosticsPath).map((event) => event.event).join(', ')}`;

      const has = (name) => readEvents(diagnosticsPath).some((event) => event.event === name);
      await waitUntil(
        () => {
          assert.equal(exit, null, `the app exited before it was ready: ${JSON.stringify(exit)}${evidence()}`);
          assert.ok(!has('daemon-service-start-failed'), `the app could not start the core${evidence()}`);
          return has('daemon-service-ready') && has('renderer-ready') && has('window-held-hidden');
        },
        { timeoutMs: BOOT_DEADLINE_MS, intervalMs: 200, message: `daemon-service-ready, renderer-ready and window-held-hidden in ${diagnosticsPath}${evidence()}` }
      );

      const events = readEvents(diagnosticsPath);
      const names = events.map((event) => event.event);
      assert.ok(!names.includes('window-shown'), `a window was shown${evidence()}`);
      assert.ok(!names.includes('render-process-gone'), `the renderer process died${evidence()}`);
      const moduleErrors = events.filter((event) => event.event === 'renderer-console-error' && MODULE_FAILURE.test(String(event.message)));
      assert.deepEqual(moduleErrors.map((event) => event.message), [], 'the renderer failed to load a module');
      assert.ok(!MODULE_FAILURE.test(output), `the main process failed to load a module${evidence()}`);

      const discovery = readJson(discoveryPath);
      assert.equal(discovery?.core?.state, 'serving', `the core is not serving: ${JSON.stringify(discovery?.core)}`);
      assert.ok(Number.isInteger(discovery.core.rpc?.port), 'the serving core publishes its RPC port');
      assert.ok(alive(discovery.pid), `the core of ${discoveryPath} (pid ${discovery.pid}) is not running`);
      corePid = discovery.pid;

      // A held-hidden app quits (through its normal quit sequence) once this file appears in its profile.
      await writeFile(join(userData, 'quit-request'), '');
      await waitUntil(() => exit !== null, { timeoutMs: QUIT_DEADLINE_MS, intervalMs: 200, message: `the app (pid ${app.pid}) to quit after the quit request${evidence()}` });

      // Stop the core the app started: a core with no work stops on request.
      await promisify(execFile)(coreBin, ['ctl', 'stop', '--when-idle', '--reason', 'quit'], { env, windowsHide: true, timeout: CORE_STOP_DEADLINE_MS }).catch(() => {});
      await waitUntil(() => !alive(corePid), { timeoutMs: CORE_STOP_DEADLINE_MS, intervalMs: 200, message: `the core (pid ${corePid}) to stop after "ctl stop"` });
      corePid = null;
      finished = true;
    } finally {
      // Only the two processes this test started, by the pids it recorded.
      if (app && exit === null) app.kill();
      if (corePid !== null && alive(corePid)) process.kill(corePid);
      const left = await processesNaming(root);
      for (const { pid } of left) if (alive(pid)) process.kill(pid);
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      // A failed run reports its own error, not this one.
      if (finished) assert.deepEqual(left, [], 'processes still running from the throwaway folder after the app and the core stopped');
    }
  }
);
