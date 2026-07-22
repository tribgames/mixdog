/**
 * clipboard.mjs — OS-clipboard write helpers extracted verbatim from App.jsx.
 * Pure module functions (spawn/process/Buffer only); no React, no App state.
 */
import { Buffer } from 'node:buffer';
import { spawn } from 'node:child_process';

function osc52ClipboardSequence(text) {
  const b64 = Buffer.from(String(text ?? ''), 'utf8').toString('base64');
  const raw = `\x1b]52;c;${b64}\x07`;
  if (!process.env.TMUX) return raw;
  return `\x1bPtmux;${raw.replaceAll('\x1b', '\x1b\x1b')}\x1b\\`;
}

// Base64 of large selections becomes a multi-hundred-KB TTY write. Emitting
// that as a single OSC 52 sequence blocks the terminal (and our render loop)
// for a noticeable beat, so skip OSC 52 past this size and rely on the native
// helper. ~256KB of clipboard text → ~350KB of base64.
const OSC52_MAX_BYTES = 256 * 1024;

// On native Windows (ConPTY) a large OSC 52 base64 payload written synchronously
// to stdout can stall for multiple seconds under terminal backpressure while a
// mouse selection is active — a debugger-confirmed Ctrl+C copy freeze. clip.exe
// alone is the reliable local clipboard writer, so skip OSC 52 entirely on
// win32 UNLESS we're in a remote/multiplexed session (SSH or tmux) where OSC 52
// is the only way to reach the user's real terminal.
function shouldSkipOsc52() {
  if (process.platform !== 'win32') return false;
  if (process.env.TMUX) return false;
  if (process.env.SSH_CONNECTION || process.env.SSH_TTY) return false;
  return true;
}

function writeOsc52Clipboard(text) {
  const value = String(text ?? '');
  if (shouldSkipOsc52()) return false;
  if (Buffer.byteLength(value, 'utf8') > OSC52_MAX_BYTES) return false;
  try {
    process.stdout.write(osc52ClipboardSequence(value));
    return true;
  } catch {
    return false;
  }
}

function nativeClipboardCommand(text) {
  const value = String(text ?? '');
  if (process.platform === 'win32') {
    // clip.exe starts in tens of ms (vs 1s+ for powershell.exe). It reads its
    // stdin as UTF-16LE, so feed plain UTF-16LE bytes for correct Unicode. No
    // BOM: clip.exe copies a leading FF FE verbatim, leaking U+FEFF as the
    // first pasted char.
    return {
      cmd: 'clip.exe',
      args: [],
      input: Buffer.from(value, 'utf16le'),
    };
  }
  if (process.platform === 'darwin') return { cmd: 'pbcopy', args: [], input: value };
  if (process.env.WAYLAND_DISPLAY) return { cmd: 'wl-copy', args: [], input: value };
  return { cmd: 'xclip', args: ['-selection', 'clipboard'], input: value };
}

export function copyToClipboard(text) {
  const value = String(text ?? '');
  const wroteOsc52 = writeOsc52Clipboard(value);
  // When OSC 52 already wrote the clipboard, fire-and-forget the native helper
  // and resolve immediately so the TUI never blocks on subprocess startup/exit
  // (clip.exe/pbcopy/etc. still finish in the background). When OSC 52 was
  // skipped (payload too large), the native helper is the ONLY writer, so we
  // must await its exit to report real success/failure instead of a false
  // "copied" hint.
  return new Promise((resolve, reject) => {
    const { cmd, args, input } = nativeClipboardCommand(value);
    let child;
    try {
      child = spawn(cmd, args, { stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true });
    } catch (e) {
      if (wroteOsc52) resolve();
      else reject(e);
      return;
    }
    child.on('error', (e) => {
      // Surface only if OSC 52 didn't cover us; otherwise the copy still landed.
      if (!wroteOsc52) reject(e);
    });
    if (!wroteOsc52) {
      child.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`${cmd} exited with code ${code}`));
      });
    }
    child.stdin.on('error', () => { /* ignore EPIPE if the helper closed early */ });
    child.stdin.end(input);
    // OSC 52 covered us: resolve now, don't await the child's exit.
    if (wroteOsc52) {
      child.unref?.();
      resolve();
    }
  });
}
