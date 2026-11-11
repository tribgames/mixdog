// node-pty's stand-in for recordings that compare a terminal's bytes with the core's (an external program as a scripted stand-in): the
// terminal manager's `spawn` gets, in place of a ConPTY shell, the scripted shell mixdog-spawn's replay mode runs over pipes
// (native/mixdog-spawn/src/scripted.rs `profile`, the same program and script): it writes back each line it reads, ended `\r\n`, in one
// write, and exits with the code of a line `@exit <code>`. A console adds sequences and cuts of its own; pipes carry exactly what the
// program wrote, so what reaches a phone is what the recording typed. The terminal manager's own code (shell plan, marker scanner, replay
// buffer, exit line) runs unchanged on what this delivers. Loaded through scripted-pty-hooks.mjs.
import { spawn as start } from 'node:child_process';

/** The program and script of native/mixdog-spawn/src/scripted.rs `profile` on Windows, byte for byte. */
const SCRIPT =
  "$in = [Console]::In; $out = [Console]::Out; while ($null -ne ($l = $in.ReadLine())) { if ($l -match '^@exit (\\d+)$') { exit [int]$Matches[1] }; $out.Write($l + [char]13 + [char]10); $out.Flush() }";
export const SCRIPTED_SHELL = {
  path: 'powershell.exe',
  args: ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(SCRIPT, 'utf16le').toString('base64')],
};

/** node-pty's `spawn(file, args, options)`: the shell the manager planned is not started; the scripted one is, in `options.cwd` with
 *  `options.env`. Its stdout is the pty's data (UTF-8, as node-pty decodes it); its end, once its output is read, the pty's exit. */
export function spawn(_file, _args, options = {}) {
  const child = start(SCRIPTED_SHELL.path, SCRIPTED_SHELL.args, { cwd: options.cwd, env: options.env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const data = new Set();
  const exits = new Set();
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (text) => data.forEach((listener) => listener(text)));
  // The script writes nothing to stderr; a failure of PowerShell itself would show there.
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (text) => process.stderr.write(`scripted shell ${child.pid}: ${text}`));
  // Input to a shell that has ended is dropped, as a closed console's is.
  child.stdin.on('error', () => undefined);
  // `close` comes once the output is read: the exit line follows the last output, as node-pty's exit does. A kill ends the program with
  // libuv's TerminateProcess code, 1, which Node reports as a signal.
  child.on('close', (code) => exits.forEach((listener) => listener({ exitCode: code ?? 1, signal: undefined })));
  return {
    pid: child.pid,
    cols: options.cols,
    rows: options.rows,
    process: SCRIPTED_SHELL.path,
    onData: (listener) => (data.add(listener), { dispose: () => data.delete(listener) }),
    onExit: (listener) => (exits.add(listener), { dispose: () => exits.delete(listener) }),
    write: (text) => child.stdin.write(text),
    resize: () => undefined,
    pause: () => child.stdout.pause(),
    resume: () => child.stdout.resume(),
    kill: () => child.kill(),
  };
}
