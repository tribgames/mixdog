'use strict';

import { spawn, spawnSync } from 'node:child_process';

function positiveInt(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

// On Windows a windowless, orphaned pwsh->cli chain keeps the immediate parent
// PID alive after its terminal window is closed, so parent-liveness alone never
// releases the worker. When the session is genuinely interactive (a TTY), the
// controlling console window is owned by a host process (conhost.exe) that dies
// with the terminal — monitoring that PID turns "terminal closed" into a fatal
// orphan signal. Returns null for non-interactive/service/hidden-console starts
// (no TTY, or no console window) so those are never treated as terminal loss.
function detectControllingTerminalPid() {
  if (process.platform !== 'win32') return null;
  // Gate on a real TTY: a service/pipe/hidden launch has no controlling
  // terminal, and probing one there would spawn a transient console whose host
  // dies immediately — a false "terminal lost" that would kill a healthy worker.
  const interactive = Boolean(
    (process.stdin && process.stdin.isTTY) || (process.stdout && process.stdout.isTTY),
  );
  if (!interactive) return null;
  try {
    const systemRoot = process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows';
    const powershell = systemRoot + '\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
    const script = [
      'Add-Type @"',
      'using System;',
      'using System.Runtime.InteropServices;',
      'public class MixdogTerm {',
      '  [DllImport("kernel32.dll")] public static extern IntPtr GetConsoleWindow();',
      '  [DllImport("user32.dll")] public static extern int GetWindowThreadProcessId(IntPtr h, out int pid);',
      '}',
      '"@',
      '$h=[MixdogTerm]::GetConsoleWindow()',
      'if($h -eq [IntPtr]::Zero){ Write-Output 0 } else { $p=0; [void][MixdogTerm]::GetWindowThreadProcessId($h,[ref]$p); Write-Output $p }',
    ].join('\n');
    // NO windowsHide: CREATE_NO_WINDOW gives the probe its own/absent console so
    // GetConsoleWindow() returns 0 or a foreign hwnd. A plain console app spawned
    // from a console-attached parent (this runs at the guardian start site, in the
    // guarded parent) inherits that console with no window flash. Under Windows
    // Terminal/ConPTY the owner is the tab's conhost (dies on tab close), which is
    // exactly the pid we want to monitor.
    const res = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], {
      timeout: 4000,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const pid = positiveInt(String((res && res.stdout) || '').trim());
    // Ignore our own PID: that would make the guardian its own kill trigger.
    if (pid && pid !== process.pid) return pid;
    return null;
  } catch {
    return null;
  }
}

function guardianScript({ parentPid, childPid, childGroupPid, terminalPid, platform, pollMs, orphanGraceMs, forceGraceMs }) {
  return `
const { spawnSync } = require('node:child_process');
const parentPid = ${JSON.stringify(parentPid)};
const childPid = ${JSON.stringify(childPid)};
const childGroupPid = ${JSON.stringify(childGroupPid || childPid)};
const terminalPid = ${JSON.stringify(terminalPid || 0)};
const platform = ${JSON.stringify(platform)};
const pollMs = ${JSON.stringify(pollMs)};
const orphanGraceMs = ${JSON.stringify(orphanGraceMs)};
const forceGraceMs = ${JSON.stringify(forceGraceMs)};
function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error && error.code === 'EPERM'; }
}
function killTarget(force) {
  if (platform === 'win32') {
    const systemRoot = process.env.SystemRoot || process.env.WINDIR || 'C:\\\\Windows';
    const taskkill = systemRoot + '\\\\System32\\\\taskkill.exe';
    if (force) {
      try { spawnSync(taskkill, ['/PID', String(childPid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); } catch {}
    } else {
      try { process.kill(childPid, 'SIGTERM'); } catch {}
      try { spawnSync(taskkill, ['/PID', String(childPid), '/T'], { stdio: 'ignore', windowsHide: true }); } catch {}
    }
    return;
  }
  const signal = force ? 'SIGKILL' : 'SIGTERM';
  try { process.kill(-childGroupPid, signal); return; } catch {}
  try { process.kill(childPid, signal); } catch {}
}
let killing = false;
let orphanedAt = 0;
const timer = setInterval(() => {
  if (!alive(childPid)) process.exit(0);
  // Orphaned when the parent PID dies OR (interactive only) the controlling
  // terminal's console host dies — the latter catches a windowless pwsh->cli
  // chain that outlives its closed terminal window. terminalPid is 0 for
  // non-interactive starts, so those fall back to pure parent-liveness.
  const terminalLost = terminalPid > 0 && !alive(terminalPid);
  if (alive(parentPid) && !terminalLost) {
    orphanedAt = 0;
    return;
  }
  if (!orphanedAt) orphanedAt = Date.now();
  if (killing || Date.now() - orphanedAt < orphanGraceMs) return;
  killing = true;
  killTarget(false);
  setTimeout(() => { if (alive(childPid)) killTarget(true); process.exit(0); }, forceGraceMs).unref?.();
}, pollMs);
`;
}

export function startChildGuardian({
  parentPid = process.pid,
  childPid,
  childGroupPid = childPid,
  label = 'child',
  pollMs = 750,
  graceMs = 3000,
  orphanGraceMs = graceMs,
  forceGraceMs = graceMs,
} = {}) {
  const parent = positiveInt(parentPid);
  const child = positiveInt(childPid);
  if (!parent || !child || parent === child) return null;

  try {
    const guardian = spawn(process.execPath, [
      '--no-warnings',
      '--eval',
      guardianScript({
        parentPid: parent,
        childPid: child,
        childGroupPid: positiveInt(childGroupPid) || child,
        terminalPid: detectControllingTerminalPid() || 0,
        platform: process.platform,
        pollMs: Math.max(100, Math.floor(Number(pollMs) || 750)),
        orphanGraceMs: Math.max(100, Math.floor(Number(orphanGraceMs) || Number(graceMs) || 3000)),
        forceGraceMs: Math.max(100, Math.floor(Number(forceGraceMs) || Number(graceMs) || 3000)),
      }),
    ], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env: {
        PATH: process.env.PATH || '',
        SystemRoot: process.env.SystemRoot || process.env.WINDIR || '',
        WINDIR: process.env.WINDIR || process.env.SystemRoot || '',
      },
    });
    guardian.unref?.();
    return { pid: guardian.pid || null, label, childPid: child };
  } catch {
    return null;
  }
}
