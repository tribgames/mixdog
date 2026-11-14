// The isolated dev instance (desktop + core) of a live run: core staging (dev-core-install.mjs), start/stop through
// apps/desktop/scripts/dev-isolated.mjs under the run's own isolated root, the core identity check (daemon.json pid ->
// executable path) and the copy-out of history/logs before stop.
import { execFile, spawn } from 'node:child_process';
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, readlinkSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

import { INSTANCE_NAME } from './paths.mjs';

const exec = promisify(execFile);

export const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));

export function freePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolvePort(port));
    });
  });
}

/**
 * Copies the core to `<isoRoot>/core/` (once per source build: the built binary's folder is never written) and writes
 * the js-runtime.json a product install has beside it. Returns the staged executable and the manifest.
 */
export async function prepareCore({ coreExe, desktopDir, repoRoot, isoRoot, ortLibrary, log = console.log }) {
  const dir = join(isoRoot, 'core');
  const staged = join(dir, process.platform === 'win32' ? 'mixdogd.exe' : 'mixdogd');
  const st = statSync(coreExe);
  const marker = join(dir, 'source.json');
  const want = { path: coreExe, size: st.size, mtimeMs: st.mtimeMs };
  let have = null;
  try {
    have = JSON.parse(readFileSync(marker, 'utf8'));
  } catch {}
  mkdirSync(dir, { recursive: true });
  if (!existsSync(staged) || !have || have.path !== want.path || have.size !== want.size || have.mtimeMs !== want.mtimeMs) {
    log(`core: copying ${coreExe} (${(st.size / 1e6).toFixed(1)} MB, built ${st.mtime.toISOString()}) to ${staged}`);
    copyFileSync(coreExe, staged);
    writeFileSync(marker, JSON.stringify(want, null, 2));
  }
  const { writeDevInstall } = await import(new URL(`file:///${join(desktopDir, 'scripts', 'dev-core-install.mjs').replace(/\\/g, '/')}`).href);
  const { file, manifest } = await writeDevInstall({ exe: staged, ortLibrary, packageRoot: repoRoot });
  log(`core: wrote ${file}`);
  return { ...want, exe: staged, manifest };
}

/** The environment of the starter: the parent's, minus what the instance env would drop anyway, plus its inputs. */
export function starterEnv({ coreExe, isoRoot, electronDist, parent = process.env }) {
  const env = { ...parent };
  delete env.ELECTRON_RUN_AS_NODE;
  env.MIXDOGD_BIN = coreExe;
  env.MIXDOG_DEV_ISOLATED_ROOT = isoRoot;
  // Never run electron's install.js against a shared node_modules: a named binary is used where it is.
  if (electronDist) env.ELECTRON_OVERRIDE_DIST_PATH = electronDist;
  return env;
}

/** The `dev-isolated.mjs start` arguments of a run. */
export function startArgs({ name = INSTANCE_NAME, ttlMinutes = 90, timeoutSeconds = 900, overlayFile, inspectorPort, passEnv = [] }) {
  return [
    'start',
    '--name',
    name,
    '--ttl-minutes',
    String(ttlMinutes),
    '--timeout-seconds',
    String(timeoutSeconds),
    ...(overlayFile ? [`--config-overlay=${overlayFile}`] : []),
    ...(inspectorPort ? [`--inspect-main=${inspectorPort}`] : []),
    ...(passEnv.length ? [`--pass-env=${passEnv.join(',')}`] : []),
  ];
}

function run(desktopDir, args, env, logFile, timeoutMs) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, [join(desktopDir, 'scripts', 'dev-isolated.mjs'), ...args], { cwd: desktopDir, env, windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`dev-isolated ${args[0]} timed out after ${timeoutMs} ms`));
    }, timeoutMs);
    child.on('exit', (code) => {
      clearTimeout(timer);
      writeFileSync(logFile, `exit ${code}\n--- stdout\n${stdout}\n--- stderr\n${stderr}\n`);
      resolveRun({ code, stdout, stderr });
    });
  });
}

/** An instance controller bound to one core/isolated root: start, stop, sweep. */
export function instanceController({ desktopDir, coreExe, isoRoot, electronDist, name = INSTANCE_NAME, log = console.log }) {
  const logs = join(isoRoot, 'logs');
  const env = () => starterEnv({ coreExe, isoRoot, electronDist });
  return {
    logs,
    /**
     * Starts the instance. `inspectorPort` is the dev Electron main's V8 inspector; `config` is laid over the seeded
     * mixdog-config.json before the core starts.
     */
    async start({ inspectorPort, config, passEnv, ttlMinutes = 90 }) {
      mkdirSync(logs, { recursive: true });
      const overlayFile = join(logs, 'config-overlay.json');
      writeFileSync(overlayFile, JSON.stringify(config ?? {}, null, 2));
      const logFile = join(logs, `start-${Date.now()}.log`);
      log(`instance: starting ${name} (root ${isoRoot}, inspector ${inspectorPort ?? 'off'}); starter log ${logFile}`);
      const started = Date.now();
      const { code, stdout, stderr } = await run(desktopDir, startArgs({ name, ttlMinutes, overlayFile, inspectorPort, passEnv }), env(), logFile, 960_000);
      const line = stdout.trim().split(/\r?\n/).reverse().find((l) => l.startsWith('{'));
      if (code !== 0 || !line) throw new Error(`instance start failed (exit ${code}): ${stderr.slice(-1500)}`);
      const info = JSON.parse(line);
      log(`instance: window loaded after ${((Date.now() - started) / 1000).toFixed(1)} s; dataDir ${info.dataDir}`);
      return { ...info, inspectorPort, startMs: Date.now() - started };
    },
    async stop() {
      mkdirSync(logs, { recursive: true });
      const { code, stdout, stderr } = await run(desktopDir, ['stop', '--name', name], env(), join(logs, `stop-${Date.now()}.log`), 120_000);
      log(`instance: stop exit ${code} ${stdout.trim().slice(0, 400)} ${stderr.trim().slice(0, 400)}`);
      return code;
    },
    async sweep() {
      mkdirSync(logs, { recursive: true });
      const { code, stdout } = await run(desktopDir, ['sweep', '--all'], env(), join(logs, `sweep-${Date.now()}.log`), 120_000);
      log(`instance: sweep exit ${code} ${stdout.trim().slice(0, 400)}`);
      return code;
    },
  };
}

/** The discovery document once the core is serving. */
export async function waitCore(info, timeoutMs = 180_000) {
  const file = join(info.profile, 'runtime', 'daemon.json');
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const doc = JSON.parse(readFileSync(file, 'utf8'));
      if (doc?.core?.state === 'serving' && doc.core.rpc?.port && doc.endpoints?.session?.token) return doc;
      if (doc?.core?.state === 'blocked') throw new Error(`core blocked: ${JSON.stringify(doc.core.blocked)}`);
    } catch (error) {
      if (/blocked/.test(error.message)) throw error;
    }
    if (Date.now() > deadline) throw new Error(`core not serving after ${timeoutMs} ms (${file})`);
    await sleep(500);
  }
}

/** The executable path out of `Get-CimInstance Win32_Process ... | ConvertTo-Json` output (empty output: no such process). */
export function parseCimProcess(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return { executablePath: '', commandLine: '' };
  const row = JSON.parse(text);
  return { executablePath: row?.ExecutablePath ?? '', commandLine: row?.CommandLine ?? '' };
}

/** Whether two executable paths name the same file (case-insensitive and slash-agnostic on Windows). */
export function samePath(a, b, platform = process.platform) {
  if (!a || !b) return false;
  const norm = (p) => (platform === 'win32' ? resolve(p).replace(/\//g, '\\').toLowerCase() : resolve(p));
  return norm(a) === norm(b);
}

async function processImage(pid, platform) {
  if (platform === 'win32') {
    const { stdout } = await exec(
      'powershell.exe',
      ['-NoLogo', '-NoProfile', '-Command', `Get-CimInstance Win32_Process -Filter "ProcessId=${Number(pid)}" | Select-Object ProcessId,ExecutablePath,CommandLine,CreationDate | ConvertTo-Json -Compress`],
      { windowsHide: true }
    );
    return parseCimProcess(stdout);
  }
  if (platform === 'linux') {
    try {
      return { executablePath: readlinkSync(`/proc/${Number(pid)}/exe`), commandLine: '' };
    } catch {
      return { executablePath: '', commandLine: '' };
    }
  }
  const { stdout } = await exec('ps', ['-p', String(Number(pid)), '-o', 'comm=']).catch(() => ({ stdout: '' }));
  return { executablePath: stdout.trim(), commandLine: '' };
}

/** daemon.json's pid must be a process running `expected` (this run's staged core), else the run is not what it claims. */
export async function verifyCore(doc, expected, platform = process.platform) {
  const pid = doc.pid;
  const { executablePath, commandLine } = await processImage(pid, platform);
  return { pid, ours: samePath(executablePath, expected, platform), executablePath, commandLine, expected };
}

/** Copies history/*, launcher.log and the host timing file out of the instance (stop/sweep delete the instance dir). */
export function collect(info, outDir, log = console.log) {
  mkdirSync(outDir, { recursive: true });
  const copied = [];
  const tryCopy = (from, to, dir = false) => {
    try {
      if (!existsSync(from)) return;
      if (dir) cpSync(from, to, { recursive: true });
      else copyFileSync(from, to);
      copied.push(to);
    } catch (error) {
      log(`collect: could not copy ${from}: ${error.message}`);
    }
  };
  tryCopy(join(info.dataDir, 'history'), join(outDir, 'history'), true);
  tryCopy(info.logPath, join(outDir, 'launcher.log'));
  tryCopy(join(info.dataDir, 'mixdog-config.json'), join(outDir, 'mixdog-config.json'));
  tryCopy(join(info.profile, 'runtime', 'daemon.json'), join(outDir, 'daemon.json'));
  return copied;
}
