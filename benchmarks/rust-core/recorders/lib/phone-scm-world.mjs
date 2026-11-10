// The world of the phone-scm recording: the child processes the Node host spawns for tools that must never really run
// (`gh`, `winget`, `soffice.com`, `git --version` when git is "missing") are answered from the scripted rules in
// apps/desktop/src/renderer/fixtures/phone-scm/gh-script.json; every other process (real git on scratch repositories) runs.
// `child_process.execFile` is the one spawn seam of github-cli.ts, gh-cli.ts, cli-run.ts and src/runtime/github/client.mjs, so
// replacing it (and `fs.existsSync` for the one gh path the Windows probe looks for) scripts them all without touching Node's code.
import cp from 'node:child_process';
import { EventEmitter } from 'node:events';
import net from 'node:net';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { basename, dirname, join } from 'node:path';
import { PassThrough } from 'node:stream';
import { promisify } from 'node:util';

const clone = (value) => JSON.parse(JSON.stringify(value));

// A wait on this world that never ends is a defect to name, not a hang. The real timer is taken at load, before the recorder replaces the clock.
const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;
function bounded(promise, message) {
  let timer;
  const stalled = new Promise((_, reject) => (timer = realSetTimeout(() => reject(new Error(message)), 90_000)));
  return Promise.race([promise, stalled]).finally(() => realClearTimeout(timer));
}

/**
 * The environment a child gets, as what its starter set or removed on top of the environment `base` it inherits from: every name that
 * is new or has another value, and every inherited name left out. A starter that passes no environment changes nothing. Names are
 * compared as the platform does (case-insensitively on Windows).
 */
export function envDelta(env, base) {
  const key = (name) => (process.platform === 'win32' ? name.toUpperCase() : name);
  if (!env) return { set: {}, remove: [] };
  const given = new Map(Object.entries(env).map(([name, value]) => [key(name), String(value)]));
  const inherited = new Map(Object.entries(base).map(([name, value]) => [key(name), String(value)]));
  const set = {};
  for (const [name, value] of [...given].sort(([a], [b]) => (a < b ? -1 : 1))) if (inherited.get(name) !== value) set[name] = value;
  const remove = [...inherited.keys()].filter((name) => !given.has(name)).sort();
  return { set, remove };
}

/**
 * The rules of gh-script.json and the world they change: one engine answers both the Node host (execFile below) and the
 * executables the replay puts on a built mixdogd's PATH (serveShims below), so Node and the core see the same tools.
 * `answer` is null for a `git` the script does not cover (it runs for real).
 */
export function createScriptEngine({ script, onSpawn }) {
  const world = clone(script.world);
  const unscripted = [];
  const listeners = [];

  const matches = (rule, tool, argv) => {
    if (rule.tool !== tool) return false;
    for (const [key, want] of Object.entries(rule.when ?? {})) if (world[key] !== want) return false;
    for (let i = 0; i < rule.argv.length; i += 1) {
      const pattern = rule.argv[i];
      if (pattern === '**') return true;
      if (i >= argv.length || (pattern !== '*' && pattern !== argv[i])) return false;
    }
    return rule.argv.length === argv.length;
  };

  const answer = (tool, argv, cwd, env) => {
    const missing = tool === 'gh' && !world.ghInstalled;
    const rule = missing ? null : script.rules.find((candidate) => matches(candidate, tool, argv));
    if (!missing && !rule) {
      if (tool === 'git') return null;
      // The recording fails at its end (a throw here would only become that call's error frame).
      unscripted.push({ tool, argv: clone(argv), world: clone(world) });
    }
    const reply = missing ? { code: -1, stderr: 'ENOENT' } : (rule?.reply ?? { code: 1, stderr: 'unscripted' });
    Object.assign(world, rule?.set ?? {});
    // What the real tool does to the repository it is run in (a checked-out pull request): these git commands, run for real here, so
    // the repository changes as it does for either product.
    for (const args of rule?.effect ?? []) {
      const done = cp.spawnSync(process.env.PHONE_SCM_REAL_GIT, ['-c', 'core.autocrlf=false', ...args], { cwd, encoding: 'utf8', timeout: 120_000, killSignal: 'SIGKILL' });
      if (done.error || done.status !== 0) unscripted.push({ tool, argv: clone(argv), effect: args, failed: done.error?.message ?? done.stderr });
    }
    onSpawn({ tool, argv: clone(argv), cwd: cwd ?? null, env: envDelta(env, process.env), reply: clone(reply) });
    for (const listener of listeners) listener(tool, argv);
    return reply;
  };
  return { world, unscripted, answer, onAnswer: (listener) => listeners.push(listener) };
}

export function installScriptedProcesses({ script, binDir, onSpawn }) {
  const engine = createScriptEngine({ script, onSpawn });
  const { world, unscripted } = engine;
  const realExecFile = cp.execFile;
  const realExists = fs.existsSync;
  const ghExe = join(binDir, 'gh.exe').toLowerCase();

  const toolOf = (file, argv) => {
    const name = basename(String(file)).toLowerCase().replace(/\.(exe|cmd|bat)$/, '');
    if (name === 'gh' || name === 'winget' || name === 'brew') return name;
    if (name === 'soffice.com' || name === 'soffice') return 'soffice.com';
    if (name === 'git' && argv.length === 1 && argv[0] === '--version') return 'git';
    return null;
  };

  cp.execFile = function execFile(file, argv, options, callback) {
    if (typeof argv === 'function') [argv, options, callback] = [[], {}, argv];
    else if (typeof options === 'function') [options, callback] = [{}, options];
    argv = argv ?? [];
    const tool = toolOf(file, argv);
    if (!tool) {
      // Real git runs, but the machine's own git.exe path never reaches the recording: an error names the scripted path.
      const name = basename(String(file)).toLowerCase().replace(/\.exe$/, '');
      // The one real program of this world is git on scratch repositories; any other would be a real installer, account tool or browser.
      if (name !== 'git') throw new Error(`phone-scm world: ${file} is not scripted and must not run for real`);
      if (!callback || !script.gitPath) return realExecFile.call(this, file, argv, options, callback);
      return realExecFile.call(this, file, argv, options, (error, ...rest) => {
        if (error) for (const key of ['message', 'cmd']) if (typeof error[key] === 'string') error[key] = error[key].split(String(file)).join(script.gitPath);
        return callback(error, ...rest);
      });
    }    const child = new EventEmitter();
    child.stdin = new PassThrough();
    const reply = engine.answer(tool, argv, options?.cwd, options?.env);
    if (!reply) return realExecFile.call(this, file, argv, options, callback);
    // The callback arrives asynchronously, as a real child's exit does, with execFile's own error shape.
    Promise.resolve().then(() => {
      const stdout = reply.stdout ?? '';
      const stderr = reply.stderr ?? '';
      if (reply.code === 0) return callback?.(null, stdout, stderr);
      const error = Object.assign(new Error(reply.code === -1 ? `spawn ${tool} ENOENT` : `Command failed: ${tool} ${argv.join(' ')}\n${stderr}`), {
        code: reply.code === -1 ? 'ENOENT' : reply.code,
      });
      return callback?.(error, stdout, stderr);
    });
    return child;
  };
  cp.execFile[promisify.custom] = realExecFile[promisify.custom];
  fs.existsSync = (path) => (String(path).toLowerCase() === ghExe ? world.ghInstalled : realExists(path));
  syncBuiltinESMExports();
  return {
    engine,
    world,
    unscripted,
    restore() {
      cp.execFile = realExecFile;
      fs.existsSync = realExists;
      syncBuiltinESMExports();
    },
  };
}

/** The login flow's PTY: gh prints what the script says and exits when it says, no process. */
export function scriptedPty({ onSpawn }) {
  const spawned = [];
  return {
    spawned,
    module: {
      spawn(file, argv, options) {
        const data = [];
        const exit = [];
        // How the terminal child ended: the exit code the scenario gave it, or the kill the product asked for (first one counts).
        const record = { ended: null };
        const pty = {
          onData: (listener) => data.push(listener),
          onExit: (listener) => exit.push(listener),
          kill: () => {
            pty.killed = true;
            record.ended ??= { error: 'cancelled' };
          },
          killed: false,
        };
        const spawn = {
          tool: 'pty',
          argv: clone(argv),
          cwd: options?.cwd ?? null,
          env: envDelta(options?.env, process.env),
        };
        onSpawn(spawn);
        spawned.push({
          pty,
          record: { ...spawn, record },
          print: (text) => data.forEach((listener) => listener(text)),
          exit: (exitCode) => {
            record.ended ??= { code: exitCode };
            exit.forEach((listener) => listener({ exitCode }));
          },
        });
        return pty;
      },
    },
  };
}

const hex = (text) => Buffer.from(text, 'utf8').toString('hex');
const unhex = (text) => Buffer.from(text, 'hex').toString('utf8');

/**
 * The tools of the script as executables a built mixdogd runs (lib/scripted-tool.rs, one binary under the names `gh`, `winget`,
 * `soffice.com` and `git`). A tool is on the machine exactly when the script's world says so (`sync`), where the core looks for
 * it: gh in the winget links folder, soffice in the Program Files folder, winget and git on PATH. `gh auth login` is the sign-in
 * PTY: its connection stays open and the scenario prints to it and ends it (`flows`), like Node's scripted pty.
 */
export async function serveShims({ engine, onSpawn, shim, places }) {
  const flows = [];
  const waiting = [];
  const present = (file, yes) => {
    if (!yes) return fs.rmSync(file, { force: true });
    // statSync, not existsSync: the Node side patches existsSync to answer for the gh path on bin.
    if (fs.statSync(file, { throwIfNoEntry: false })) return;
    fs.mkdirSync(dirname(file), { recursive: true });
    fs.copyFileSync(shim, file);
  };
  function sync() {
    const { world } = engine;
    present(places.gh, world.ghInstalled);
    present(places.ghOnPath, world.ghInstalled);
    present(places.winget, !world.wingetMissing);
    present(places.git, !world.gitMissing);
    present(places.soffice, world.soffice);
  }
  const server = net.createServer((socket) => {
    let received = '';
    socket.on('error', () => {});
    socket.on('data', (chunk) => {
      received += chunk.toString('latin1');
      const lines = received.split('\n');
      if (lines.length < 4) return;
      const argc = Number(lines[2]);
      if (lines.length < 3 + argc + 3 + 1) return;
      socket.removeAllListeners('data');
      const [tool, cwd] = [lines[0], unhex(lines[1])];
      const argv = lines.slice(3, 3 + argc).map(unhex);
      const [prompt, browser, ghBrowser] = lines.slice(3 + argc, 6 + argc).map(unhex);
      if (process.env.PHONE_SCM_VERBOSE) console.error('[shim]', tool, JSON.stringify(argv), cwd);
      if (tool === 'gh' && argv[0] === 'auth' && argv[1] === 'login') {
        onSpawn({ tool: 'pty', argv, cwd, env: { GH_PROMPT_DISABLED: prompt, BROWSER: browser, GH_BROWSER: ghBrowser } }); // the replay's own sighting; not compared
        flows.push({ print: (text) => socket.write(`O ${hex(text)}\n`), exit: (code) => socket.write(`X ${code}\n`) });
        for (const resolve of waiting.splice(0)) resolve();
        return;
      }
      const reply = engine.answer(tool, argv, cwd);
      // What the answer changed in the world (winget installing gh) is on disk before the tool exits, as Node's probe sees it at once.
      sync();
      if (reply.stdout) socket.write(`O ${hex(reply.stdout)}\n`);
      if (reply.stderr) socket.write(`E ${hex(reply.stderr)}\n`);
      socket.write(`X ${reply.code === -1 ? 1 : reply.code}\n`);
    });
  });
  await bounded(new Promise((resolve, reject) => (server.once('error', reject), server.listen(0, '127.0.0.1', resolve))), 'the shim server did not start listening');
  return {
    address: `127.0.0.1:${server.address().port}`,
    flows,
    /** The nth PTY the core started (resolves when it connects). */
    async flow(n) {
      await bounded(
        (async () => {
          while (!flows[n]) await new Promise((resolve) => waiting.push(resolve));
        })(),
        `the core never started sign-in terminal ${n}`,
      );
      return flows[n];
    },
    sync,
    /** Whether the tool has no executable anywhere the core looks for it (after the last `sync`). */
    absent(tool) {
      const files = { gh: [places.gh, places.ghOnPath], winget: [places.winget], git: [places.git], 'soffice.com': [places.soffice] }[tool];
      return files.every((file) => !fs.statSync(file, { throwIfNoEntry: false }));
    },
    close: () => server.close(),
  };
}