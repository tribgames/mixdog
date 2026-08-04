import { spawn } from 'child_process';
import { isWSL } from './wsl.mjs';
import { detachedSpawnOpts } from './spawn-flags.mjs';

/**
 * Open a URL in the user's default browser. Best-effort and non-blocking.
 * Callers also print the URL, so opener failure should never block OAuth.
 */
export function openInBrowser(url) {
  const u = String(url);
  let candidates;
  if (process.platform === 'win32') {
    const systemRoot = process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows';
    candidates = [[`${systemRoot}\\System32\\rundll32.exe`, ['url.dll,FileProtocolHandler', u]]];
  } else if (process.platform === 'darwin') {
    candidates = [['open', [u]]];
  } else if (isWSL()) {
    const psUrl = `'${u.replace(/'/g, "''")}'`;
    candidates = [
      ['wslview', [u]],
      ['powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `Start-Process -FilePath ${psUrl}`]],
    ];
  } else {
    candidates = [['xdg-open', [u]]];
  }
  tryOpenCandidates(candidates, 0);
}

function tryOpenCandidates(candidates, index) {
  if (index >= candidates.length) return;
  const [cmd, args] = candidates[index];
  try {
    const child = spawn(cmd, args, { stdio: 'ignore', ...detachedSpawnOpts });
    child.on('error', () => { tryOpenCandidates(candidates, index + 1); });
    child.unref();
  } catch {
    tryOpenCandidates(candidates, index + 1);
  }
}
