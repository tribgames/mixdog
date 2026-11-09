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

  const answer = (tool, argv, cwd) => {
    const missing = tool === 'gh' && !world.ghInstalled;
    const rule = missing ? null : script.rules.find((candidate) => matches(candidate, tool, argv));
    if (!missing && !rule) {
      if (tool === 'git') return null;
      // The recording fails at its end (a throw here would only become that call's error frame).
      unscripted.push({ tool, argv: clone(argv), world: clone(world) });
    }
    const reply = missing ? { code: -1, stderr: 'ENOENT' } : (rule?.reply ?? { code: 1, stderr: 'unscripted' });
    Object.assign(world, rule?.set ?? {});
    onSpawn({ tool, argv: clone(argv), cwd: cwd ?? null, reply: clone(reply) });
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
    const reply = engine.answer(tool, argv, options?.cwd);
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
        const pty = {
          onData: (listener) => data.push(listener),
          onExit: (listener) => exit.push(listener),
          kill: () => {
            pty.killed = true;
          },
          killed: false,
        };
        onSpawn({
          tool: 'pty',
          argv: clone(argv),
          cwd: options?.cwd ?? null,
          env: { GH_PROMPT_DISABLED: options?.env?.GH_PROMPT_DISABLED, BROWSER: options?.env?.BROWSER, GH_BROWSER: options?.env?.GH_BROWSER },
        });
        spawned.push({
          pty,
          print: (text) => data.forEach((listener) => listener(text)),
          exit: (exitCode) => exit.forEach((listener) => listener({ exitCode })),
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
        onSpawn({ tool: 'pty', argv, cwd, env: { GH_PROMPT_DISABLED: prompt, BROWSER: browser, GH_BROWSER: ghBrowser } });
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
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    address: `127.0.0.1:${server.address().port}`,
    flows,
    /** The nth PTY the core started (resolves when it connects). */
    async flow(n) {
      while (!flows[n]) await new Promise((resolve) => waiting.push(resolve));
      return flows[n];
    },
    sync,
    close: () => server.close(),
  };
}