// WSL (Windows Subsystem for Linux) detection.
//
// process.platform reports 'linux' inside WSL, so any caller that needs
// Windows-HOST behavior — opening the Windows default browser, reaching the
// Windows credential store, translating Windows drive paths — must branch on
// this explicitly rather than on process.platform alone. Plain-Linux behavior
// stays the default; this only flags the WSL special case.
import { readFileSync } from 'node:fs';

let _isWSL;

export function isWSL() {
  if (_isWSL !== undefined) return _isWSL;
  if (process.platform !== 'linux') {
    _isWSL = false;
    return _isWSL;
  }
  if (process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP) {
    _isWSL = true;
    return _isWSL;
  }
  try {
    const v = readFileSync('/proc/version', 'utf8').toLowerCase();
    _isWSL = v.includes('microsoft') || v.includes('wsl');
  } catch {
    _isWSL = false;
  }
  return _isWSL;
}
