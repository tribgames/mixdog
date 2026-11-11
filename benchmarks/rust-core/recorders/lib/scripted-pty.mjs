// node-pty's stand-in for recordings that compare a terminal's bytes with the core's (an external program as a scripted stand-in): the
// terminal manager's `spawn` gets, in place of a ConPTY shell, the framed scripted shell mixdog-spawn's replay mode runs over pipes
// (native/mixdog-spawn/src/scripted.rs `framed_profile`, the same program and script): each line it reads is written back as chunks, each
// one frame (its length in bytes in decimal, `:`, its UTF-8 bytes) flushed on its own; `@chunks <a>|<b>|…` writes the chunks given,
// `@fill <n>` one chunk of n bytes, any other line is one chunk ended `\r\n` (in every chunk `\n`, `\e`, `\a` as `\r\n`, ESC, BEL, then
// `\xHH` as that character), and `@exit <code>` exits with that code. This hands the terminal manager exactly one data event per frame,
// whole, whatever the pipe joined or split and whatever bytes or length the frame has (as the core's `scripted::Frames` hands its reader
// one frame per output), so how output is cut into data events is the script's, not timing's. A console adds sequences and cuts of its own; pipes carry exactly what the program
// wrote. The terminal manager's own code (shell plan, marker scanner, replay buffer, exit line) runs unchanged on what this delivers.
// Loaded through scripted-pty-hooks.mjs.
import { spawn as start } from 'node:child_process';

/** The longest frame header (scripted.rs `HEADER_MAX`): a byte count in decimal and its `:`. */
const HEADER_MAX = 11;
/** The program and script of native/mixdog-spawn/src/scripted.rs `framed_profile` on Windows, byte for byte. */
const SCRIPT =
  "$in = [Console]::In; $out = [Console]::OpenStandardOutput(); $utf8 = [Text.Encoding]::UTF8; $nl = [string][char]13 + [char]10; $esc = [string][char]27; $bel = [string][char]7; while ($null -ne ($l = $in.ReadLine())) { if ($l -match '^@exit (\\d+)$') { exit [int]$Matches[1] }; if ($l -match '^@fill (\\d+)$') { $n = [int]$Matches[1]; $chunks = @(('0123456789abcdef' * ($n / 16 + 1)).Substring(0, $n)) } elseif ($l -match '^@chunks (.*)$') { $chunks = $Matches[1].Split('|') } else { $chunks = @($l + '\\n') }; foreach ($c in $chunks) { $t = [regex]::Replace($c.Replace('\\n', $nl).Replace('\\e', $esc).Replace('\\a', $bel), '\\\\x([0-9a-f]{2})', { [string][char][Convert]::ToInt32($args[0].Groups[1].Value, 16) }); $b = $utf8.GetBytes($t); $h = [Text.Encoding]::ASCII.GetBytes([string]$b.Length + ':'); $out.Write($h, 0, $h.Length); $out.Write($b, 0, $b.Length); $out.Flush() } }";
export const SCRIPTED_SHELL = {
  path: 'powershell.exe',
  args: ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(SCRIPT, 'utf16le').toString('base64')],
};

/** The whole frames at the start of `pending` (a Buffer), each its bytes, and what follows them; a header that is not a byte count and
 *  `:` throws (scripted.rs `Frames::next_frame`). */
export function takeFrames(pending) {
  const frames = [];
  let at = 0;
  for (;;) {
    const colon = pending.subarray(at, at + HEADER_MAX).indexOf(':');
    if (colon < 0) {
      if (pending.length - at >= HEADER_MAX) throw new Error(`the scripted shell's output has no frame header: ${JSON.stringify(pending.subarray(at, at + HEADER_MAX).toString('latin1'))}`);
      break;
    }
    const digits = pending.subarray(at, at + colon).toString('latin1');
    if (!/^\d+$/.test(digits)) throw new Error(`the scripted shell's output has a frame header that is not a byte count: ${JSON.stringify(digits)}`);
    const end = at + colon + 1 + Number(digits);
    if (end > pending.length) break;
    frames.push(pending.subarray(at + colon + 1, end));
    at = end;
  }
  return { frames, rest: pending.subarray(at) };
}

/** node-pty's `spawn(file, args, options)`: the shell the manager planned is not started; the scripted one is, in `options.cwd` with
 *  `options.env`. Each chunk on its stdout is one data event of the pty (UTF-8, as node-pty decodes it); its end, once its output is
 *  read, the pty's exit. */
export function spawn(_file, _args, options = {}) {
  const child = start(SCRIPTED_SHELL.path, SCRIPTED_SHELL.args, { cwd: options.cwd, env: options.env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const data = new Set();
  const exits = new Set();
  let pending = Buffer.alloc(0);
  const deliver = (frame) => {
    const text = frame.toString('utf8');
    data.forEach((listener) => listener(text));
  };
  child.stdout.on('data', (bytes) => {
    const { frames, rest } = takeFrames(Buffer.concat([pending, bytes]));
    pending = rest;
    frames.forEach(deliver);
  });
  // A frame cut off by the end of the output is the stand-in's error, never a short chunk.
  child.stdout.on('end', () => {
    if (pending.length) throw new Error(`the scripted shell ${child.pid}'s output ended inside a frame (${pending.length} bytes of it read)`);
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
