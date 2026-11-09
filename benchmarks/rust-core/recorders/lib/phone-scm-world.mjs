// The world of the phone-scm recording: the child processes the Node host spawns for tools that must never really run
// (`gh`, `winget`, `soffice.com`, `git --version` when git is "missing") are answered from the scripted rules in
// apps/desktop/src/renderer/fixtures/phone-scm/gh-script.json; every other process (real git on scratch repositories) runs.
// `child_process.execFile` is the one spawn seam of github-cli.ts, gh-cli.ts, cli-run.ts and src/runtime/github/client.mjs, so
// replacing it (and `fs.existsSync` for the one gh path the Windows probe looks for) scripts them all without touching Node's code.
import cp from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { basename, join } from 'node:path';
import { PassThrough } from 'node:stream';
import { promisify } from 'node:util';

const clone = (value) => JSON.parse(JSON.stringify(value));

export function installScriptedProcesses({ script, binDir, onSpawn }) {
  const world = clone(script.world);
  const unscripted = [];
  const realExecFile = cp.execFile;
  const realExists = fs.existsSync;
  const ghExe = join(binDir, 'gh.exe').toLowerCase();

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
    if (!tool) return realExecFile.call(this, file, argv, options, callback);
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    const missing = tool === 'gh' && !world.ghInstalled;
    const rule = missing ? null : script.rules.find((candidate) => matches(candidate, tool, argv));
    if (!missing && !rule) {
      if (tool === 'git') return realExecFile.call(this, file, argv, options, callback);
      // The recording fails at its end (a throw here would only become that call's error frame).
      unscripted.push({ tool, argv: clone(argv), world: clone(world) });
    }
    const reply = missing ? { code: -1, stderr: 'ENOENT' } : (rule?.reply ?? { code: 1, stderr: 'unscripted' });
    Object.assign(world, rule?.set ?? {});
    onSpawn({ tool, argv: clone(argv), cwd: options?.cwd ?? null, reply: clone(reply) });
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
