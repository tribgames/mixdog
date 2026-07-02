/**
 * clipboard.mjs — OS-clipboard write helpers extracted verbatim from App.jsx.
 * Pure module functions (spawn/process/Buffer only); no React, no App state.
 */
import { Buffer } from 'node:buffer';
import { spawn } from 'node:child_process';

export function osc52ClipboardSequence(text) {
  const b64 = Buffer.from(String(text ?? ''), 'utf8').toString('base64');
  const raw = `\x1b]52;c;${b64}\x07`;
  if (!process.env.TMUX) return raw;
  return `\x1bPtmux;${raw.replaceAll('\x1b', '\x1b\x1b')}\x1b\\`;
}

export function writeOsc52Clipboard(text) {
  try {
    process.stdout.write(osc52ClipboardSequence(text));
    return true;
  } catch {
    return false;
  }
}

export function nativeClipboardCommand(text) {
  if (process.platform === 'win32') {
    return {
      cmd: 'powershell.exe',
      args: [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        '$b=[Console]::In.ReadToEnd();$t=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($b));Set-Clipboard -Value $t',
      ],
      input: Buffer.from(String(text ?? ''), 'utf8').toString('base64'),
    };
  }
  if (process.platform === 'darwin') return { cmd: 'pbcopy', args: [], input: text };
  if (process.env.WAYLAND_DISPLAY) return { cmd: 'wl-copy', args: [], input: text };
  return { cmd: 'xclip', args: ['-selection', 'clipboard'], input: text };
}

export function copyToClipboard(text) {
  const value = String(text ?? '');
  const wroteOsc52 = writeOsc52Clipboard(value);
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
      if (wroteOsc52) resolve();
      else reject(e);
    });
    child.on('close', (code) => {
      if (code === 0 || wroteOsc52) resolve();
      else reject(new Error(`${cmd} exited with code ${code}`));
    });
    child.stdin.on('error', () => { /* ignore EPIPE if the helper closed early */ });
    child.stdin.end(input);
  });
}
