// For the tests of the job tooling: freezes a process (each of its threads suspended), as a guard that stops answering is.
// NtSuspendProcess answers 1 on this machine and suspends nothing; SuspendThread on each thread does.
import { spawnSync } from 'node:child_process';

const SUSPEND = `
using System;
using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
public static class Freeze {
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenThread(uint access, bool inherit, int tid);
  [DllImport("kernel32.dll", SetLastError = true)] static extern int SuspendThread(IntPtr thread);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool CloseHandle(IntPtr handle);
  public static void Suspend(int pid) {
    foreach (ProcessThread thread in Process.GetProcessById(pid).Threads) {
      IntPtr handle = OpenThread(0x0002, false, thread.Id);
      if (handle == IntPtr.Zero) throw new Win32Exception();
      try { if (SuspendThread(handle) == -1) throw new Win32Exception(); } finally { CloseHandle(handle); }
    }
  }
}`;

/** Suspends every thread `pid` has now; throws when it could not. */
export function suspendProcess(pid) {
  const script = `$ErrorActionPreference = 'Stop'\nAdd-Type -TypeDefinition @'\n${SUSPEND}\n'@\n[Freeze]::Suspend(${pid})\n`;
  const done = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { encoding: 'utf8', windowsHide: true, timeout: 60_000 });
  if (done.error || done.status !== 0) throw new Error(`suspending pid ${pid} failed: ${done.error?.message ?? done.stderr}`);
}
