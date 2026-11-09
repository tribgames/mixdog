// WSL (Windows Subsystem for Linux) detection.
//
// process.platform reports 'linux' inside WSL, so any caller that needs
// Windows-HOST behavior — opening the Windows default browser, reaching the
// Windows credential store, translating Windows drive paths — must branch on
// this explicitly rather than on process.platform alone. Plain-Linux behavior
// stays the default; this only flags the WSL special case.
//
// Detection order (cheapest / most reliable first):
//   1. WSL_DISTRO_NAME / WSL_INTEROP env vars (set by the WSL init for every
//      interactive and most non-interactive sessions).
//   2. /proc/version containing "microsoft"/"wsl" (the kernel is a Microsoft
//      build under WSL1/WSL2). Read once and memoized.
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
