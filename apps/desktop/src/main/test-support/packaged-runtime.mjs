import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { on, once } from 'node:events';
import { watch } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readdir, readFile, realpath, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import WebSocket from 'ws';
import { desktopJsRuntimeManifest, desktopMixdogRoot, UNPACKED_NODE_MODULES } from '../../../scripts/core-layout.mjs';

const windows = process.platform === 'win32';
const exec = promisify(execFile);

export async function artifactPath(root, path) {
  const target = await realpath(path);
  const location = relative(await realpath(root), target);
  assert.ok(
    location && !isAbsolute(location) && location.split(sep)[0] !== '..',
    `${path} resolves outside ${root}: ${target}`
  );
  return target;
}

export async function artifactFile(root, path) {
  const file = await artifactPath(root, path);
  assert.ok((await stat(file)).isFile(), `${file} is not a file`);
  return file;
}

async function assertRuntimeLinksContained(modules) {
  const entries = await readdir(modules, { recursive: true, withFileTypes: true });
  for (const entry of entries) {
    if (entry.isSymbolicLink()) await artifactPath(modules, join(entry.parentPath, entry.name));
  }
}

function start(program, args, options) {
  const child = spawn(program, args, {
    ...options,
    detached: !windows,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  let error;
  child.stdout.setEncoding('utf8').on('data', (chunk) => {
    stdout = (stdout + chunk).slice(-8192);
  });
  child.stderr.setEncoding('utf8').on('data', (chunk) => {
    stderr = (stderr + chunk).slice(-8192);
  });
  child.on('error', (cause) => {
    error = cause;
  });
  const done = new Promise((settled) => {
    child.once('close', (code, signal) => settled({ code, signal, error, stdout, stderr }));
  });
  return { child, done, diagnostics: () => [error?.message, stderr, stdout].filter(Boolean).join('\n') };
}

async function deadline(promise, ms, message) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function forceStop({ child, done }, options) {
  if (child.pid && child.exitCode === null && child.signalCode === null) {
    if (windows) {
      await exec(join(options.env.SystemRoot, 'System32', 'taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], {
        ...options,
        windowsHide: true,
        timeout: 10_000,
      });
    } else {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch (error) {
        if (error.code !== 'ESRCH') throw error;
      }
    }
  }
  await deadline(done, 10_000, 'packaged process did not close after termination');
}

async function run(program, args, options) {
  const process = start(program, args, options);
  try {
    const result = await deadline(process.done, 20_000, `${basename(program)} did not exit`);
    assert.ifError(result.error);
    assert.equal(
      result.code,
      0,
      `${basename(program)} failed (${result.signal ?? result.code})\n${process.diagnostics()}`
    );
    return result.stdout;
  } finally {
    await forceStop(process, options);
  }
}

async function serving(runtime, core) {
  const watcher = watch(runtime);
  const events = on(watcher, 'change', { signal: AbortSignal.timeout(60_000) });
  const discovery = async () => {
    try {
      const record = JSON.parse(await readFile(join(runtime, 'daemon.json'), 'utf8'));
      assert.equal(record.pid, core.child.pid, 'the test must connect only to the core it started');
      return record.core.state === 'serving' ? record : null;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      return null;
    }
  };
  try {
    const ready = async () => {
      const initial = await discovery();
      if (initial) return initial;
      for await (const _ of events) {
        const record = await discovery();
        if (record) return record;
      }
    };
    return await Promise.race([
      ready(),
      core.done.then(() => {
        throw new Error('packaged core exited before serving');
      }),
    ]);
  } catch (error) {
    throw new Error(`packaged core did not become ready\n${core.diagnostics()}`, { cause: error });
  } finally {
    await events.return();
    watcher.close();
  }
}

function coreRpc(socket) {
  let nextId = 0;
  return async (method, params) => {
    const id = ++nextId;
    const messages = on(socket, 'message', { signal: AbortSignal.timeout(30_000), close: ['close'] });
    try {
      socket.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
      for await (const [data, binary] of messages) {
        if (binary) continue;
        const reply = JSON.parse(data.toString());
        if (reply.id !== id || reply.method) continue;
        assert.ok(!reply.error, `${method}: ${JSON.stringify(reply.error)}`);
        return reply.result;
      }
      throw new Error(`the packaged core closed the socket during ${method}`);
    } finally {
      await messages.return();
    }
  };
}

export async function withPackagedCore(resources, version, check) {
  const coreDir = join(resources, 'core');
  const bin = await artifactFile(resources, join(coreDir, windows ? 'mixdogd.exe' : 'mixdogd'));
  const manifestFile = await artifactFile(resources, join(coreDir, 'js-runtime.json'));
  const manifest = JSON.parse(await readFile(manifestFile, 'utf8'));
  assert.deepEqual(manifest, desktopJsRuntimeManifest(process.platform, process.arch));
  const program = await artifactFile(resolve(resources, '..'), resolve(coreDir, manifest.program));
  const modules = await artifactPath(resources, join(resources, UNPACKED_NODE_MODULES));
  await assertRuntimeLinksContained(modules);
  const source = desktopMixdogRoot(resources);
  const entry = await artifactFile(modules, join(source, 'skill-script-entry.mjs'));

  const root = await mkdtemp(join(tmpdir(), 'mixdog-packaged-runtime-'));
  const data = join(root, 'data');
  const runtime = join(root, 'runtime');
  const home = join(root, 'home');
  const workspace = join(root, 'workspace');
  const temp = join(root, 'tmp');
  const env = {
    ...(windows ? { SystemRoot: process.env.SystemRoot } : {}),
    HOME: home,
    USERPROFILE: home,
    APPDATA: home,
    LOCALAPPDATA: home,
    XDG_CONFIG_HOME: home,
    XDG_DATA_HOME: home,
    XDG_CACHE_HOME: home,
    XDG_RUNTIME_DIR: runtime,
    TMPDIR: temp,
    TMP: temp,
    TEMP: temp,
    MIXDOG_ROOT: source,
    MIXDOG_HOME: home,
    MIXDOG_CONFIG_DIR: home,
    MIXDOG_DATA_DIR: data,
    MIXDOG_DESKTOP_USER_DATA: join(root, 'desktop'),
    MIXDOG_PROJECTS_FILE: join(root, 'projects.json'),
    MIXDOG_RUNTIME_ROOT: runtime,
    MIXDOG_RELAY_URL: 'off',
    MIXDOG_DISABLE_CHANNEL_START: '1',
    MIXDOG_DISABLE_MODEL_CATALOG_WARMUP: '1',
    MIXDOG_DISABLE_PROJECT_MARKERS: '1',
  };
  const options = { cwd: workspace, env };
  let core;
  let ready;
  let socket;
  let closed;
  try {
    await Promise.all([data, runtime, home, workspace, temp].map((dir) => mkdir(dir)));
    core = start(bin, ['serve'], options);
    ready = await serving(runtime, core);
    assert.equal(ready.core.version, version, 'the bundled core version must match the selected desktop version');
    socket = new WebSocket(`ws://127.0.0.1:${ready.core.rpc.port}/rpc`, {
      headers: { Authorization: `Bearer ${ready.endpoints.session.token}` },
      handshakeTimeout: 10_000,
    });
    socket.on('error', () => {}); // Open and in-flight requests report their own errors.
    closed = new Promise((resolve) => socket.once('close', resolve));
    await once(socket, 'open');
    const call = coreRpc(socket);
    await call('initialize', { clientInfo: { name: 'packaging-artifact', version, kind: 'desktop' } });
    socket.send(JSON.stringify({ jsonrpc: '2.0', method: 'initialized' }));

    const copyFixture = async (name) => {
      const path = join(workspace, name);
      await copyFile(fileURLToPath(new URL(name, import.meta.url)), path);
      return path;
    };
    const skillEnv = { ...env, MIXDOG_ARTIFACT_SKILL_ENTRY: entry };
    const runGuardedSkill = async (args) => {
      // Electron can strip NODE_OPTIONS on macOS. Preload explicitly on the
      // same packaged program and entry attested by the generated launcher.
      const guardUrl = pathToFileURL(await copyFixture('packaged-skill-guard.mjs')).href;
      return run(program, ['--import', guardUrl, entry, ...args], {
        ...options,
        env: {
          ...skillEnv,
          ELECTRON_RUN_AS_NODE: '1',
          MIXDOG_ARTIFACT_MODULES: modules,
          MIXDOG_ARTIFACT_SKILL_GUARD: guardUrl,
        },
      });
    };
    const launchSkill = async (args) => {
      const launchers = join(data, 'skill-launchers');
      const installs = await readdir(launchers);
      assert.equal(installs.length, 1, 'the isolated core must generate one set of skill launchers');
      const launcher = await artifactFile(
        launchers,
        join(launchers, installs[0], `mixdog-skill-node${windows ? '.cmd' : ''}`)
      );
      if (!windows) return run(launcher, args, { ...options, env: skillEnv });
      // Expand into quoted cmd arguments so the batch file has to forward %*.
      // The separate PowerShell carrier would skip the batch forwarding path.
      // cmd leaves %NAME% of an empty variable unexpanded, so an empty argument is a literal "".
      const values = [launcher, ...args];
      const names = values.map((_, i) => `MIXDOG_ARTIFACT_ARG_${i}`);
      const command = `"${names.map((name, i) => (values[i] ? `"%${name}%"` : '""')).join(' ')}"`;
      const commandEnv = Object.fromEntries(names.map((name, i) => [name, values[i]]));
      return run(join(env.SystemRoot, 'System32', 'cmd.exe'), ['/d', '/s', '/v:off', '/c', command], {
        ...options,
        env: { ...skillEnv, ...commandEnv },
        windowsVerbatimArguments: true,
      });
    };
    await check({ call, program, source, workspace, copyFixture, runGuardedSkill, launchSkill });
  } finally {
    try {
      socket?.terminate();
      await closed;
      if (core) {
        try {
          if (ready && core.child.exitCode === null && core.child.signalCode === null) {
            await run(bin, ['ctl', 'stop', '--force', '--reason', 'userStop', '--json'], options);
            await deadline(core.done, 20_000, 'the packaged core did not stop');
          }
        } finally {
          await forceStop(core, options);
        }
      }
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 5 });
    }
  }
}
