// node-pty's stand-in for recordings that compare a terminal's bytes with the core's (an external program as a scripted stand-in): the
// terminal manager's `spawn` gets, in place of a ConPTY shell, the framed scripted shell mixdog-spawn's replay mode runs over pipes
// (native/mixdog-spawn/src/scripted.rs `framed_profile`, the same program and script): each line it reads is written back as chunks, each
// ended by RS (0x1e) and flushed on its own; `@chunks <a>|<b>|…` writes the chunks given, any other line is one chunk ended `\r\n` (in
// every chunk `\n`, `\e`, `\a` as `\r\n`, ESC, BEL), and `@exit <code>` exits with that code. This hands the terminal manager exactly one data event per chunk, without
// its RS, whatever the pipe joined or split (as the core's `scripted::Frames` hands its reader one chunk per read), so how output is cut
// into data events is the script's, not timing's. A console adds sequences and cuts of its own; pipes carry exactly what the program
// wrote. The terminal manager's own code (shell plan, marker scanner, replay buffer, exit line) runs unchanged on what this delivers.
// Loaded through scripted-pty-hooks.mjs.
import { spawn as start } from 'node:child_process';

/** What ends each chunk (scripted.rs `FRAME_END`). */
const FRAME_END = '\x1e';
/** The program and script of native/mixdog-spawn/src/scripted.rs `framed_profile` on Windows, byte for byte. */
const SCRIPT =
  "$in = [Console]::In; $out = [Console]::Out; $nl = [string][char]13 + [char]10; $esc = [string][char]27; $bel = [string][char]7; $end = [string][char]30; while ($null -ne ($l = $in.ReadLine())) { if ($l -match '^@exit (\\d+)$') { exit [int]$Matches[1] }; if ($l -match '^@chunks (.*)$') { $chunks = $Matches[1].Split('|') } else { $chunks = @($l + '\\n') }; foreach ($c in $chunks) { $out.Write($c.Replace('\\n', $nl).Replace('\\e', $esc).Replace('\\a', $bel) + $end); $out.Flush() } }";
export const SCRIPTED_SHELL = {
  path: 'powershell.exe',
  args: ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(SCRIPT, 'utf16le').toString('base64')],
};

/** The chunks in `pending` that are ended, and what follows the last end. */
export function takeChunks(pending) {
  const parts = pending.split(FRAME_END);
  return { chunks: parts.slice(0, -1).filter((chunk) => chunk !== ''), rest: parts.at(-1) };
}

/** node-pty's `spawn(file, args, options)`: the shell the manager planned is not started; the scripted one is, in `options.cwd` with
 *  `options.env`. Each chunk on its stdout is one data event of the pty (UTF-8, as node-pty decodes it); its end, once its output is
 *  read, the pty's exit. */
export function spawn(_file, _args, options = {}) {
  const child = start(SCRIPTED_SHELL.path, SCRIPTED_SHELL.args, { cwd: options.cwd, env: options.env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const data = new Set();
  const exits = new Set();
  let pending = '';
  const deliver = (text) => data.forEach((listener) => listener(text));
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (text) => {
    const { chunks, rest } = takeChunks(pending + text);
    pending = rest;
    chunks.forEach(deliver);
  });
  // What the shell left unended when its output closed goes out last, before the exit.
  child.stdout.on('end', () => {
    if (pending) deliver(pending);
    pending = '';
  });
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
