import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const CHROME_CLOSE_TIMEOUT_MS = 30_000;

/** `tasklist` lists processes in well under a second; this only bounds a hang. */
const TASKLIST_TIMEOUT_MS = 5_000;
/** One PowerShell start (Add-Type compile) plus the WM_CLOSE posts. */
const CLOSE_REQUEST_TIMEOUT_MS = 10_000;
/** How often the wait for Chrome to exit re-lists its processes. */
const CHROME_EXIT_POLL_MS = 200;

export interface BrowserProcessCloseTarget {
  imageName: string;
  timeoutMs?: number;
}

async function browserProcessIds(tasklist: string, imageName: string): Promise<number[]> {
  const { stdout } = await execFileAsync(tasklist, ['/FI', `IMAGENAME eq ${imageName}`, '/FO', 'CSV', '/NH'], {
    windowsHide: true,
    timeout: TASKLIST_TIMEOUT_MS,
    maxBuffer: 256 * 1024,
  });
  return stdout
    .split(/\r?\n/)
    .filter((line) => line.toLowerCase().startsWith(`"${imageName.toLowerCase()}","`))
    .map((line) => Number(line.match(/^"[^"]+","(\d+)"/)?.[1]))
    .filter((pid) => Number.isInteger(pid) && pid > 0);
}

export async function prepareChromeForImport(
  target: BrowserProcessCloseTarget = {
    imageName: 'chrome.exe',
  }
): Promise<void> {
  if (process.platform !== 'win32') return;
  if (!/^[a-zA-Z0-9._-]{1,120}\.exe$/i.test(target.imageName)) {
    throw new Error('Browser process identity is invalid.');
  }
  const systemRoot = String(process.env.SystemRoot || 'C:\\Windows');
  const tasklist = join(systemRoot, 'System32', 'tasklist.exe');
  const initialProcessIds = await browserProcessIds(tasklist, target.imageName);
  if (!initialProcessIds.length) return;
  const powershell = join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const closeScript = `
$ErrorActionPreference = 'Stop'
Add-Type @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class MixdogBrowserWindowClose {
  private delegate bool EnumWindowsProc(IntPtr hwnd, IntPtr lParam);
  [DllImport("user32.dll")] private static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);
  [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint processId);
  [DllImport("user32.dll", SetLastError = true)] private static extern bool PostMessage(IntPtr hwnd, uint message, IntPtr wParam, IntPtr lParam);
  public static int Close(uint[] processIds) {
    var allowed = new HashSet<uint>(processIds);
    var closed = 0;
    EnumWindows((hwnd, ignored) => {
      uint processId;
      GetWindowThreadProcessId(hwnd, out processId);
      if (allowed.Contains(processId) && PostMessage(hwnd, 0x0010, IntPtr.Zero, IntPtr.Zero)) {
        closed += 1;
      }
      return true;
    }, IntPtr.Zero);
    return closed;
  }
}
'@
$processIds = [uint32[]](ConvertFrom-Json -InputObject $env:MIXDOG_BROWSER_IMPORT_PROCESS_IDS)
[MixdogBrowserWindowClose]::Close($processIds) | Out-Null
`;
  let closeRequestFailed = false;
  try {
    await execFileAsync(
      powershell,
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', closeScript],
      {
        windowsHide: true,
        timeout: CLOSE_REQUEST_TIMEOUT_MS,
        maxBuffer: 256 * 1024,
        env: {
          ...process.env,
          MIXDOG_BROWSER_IMPORT_PROCESS_IDS: JSON.stringify(initialProcessIds),
        },
      }
    );
  } catch {
    closeRequestFailed = true;
    // A process can disappear while its top-level windows are enumerated. The
    // bounded wait below is the source of truth and never force-terminates it.
  }
  const deadline = Date.now() + Math.max(1_000, Math.min(120_000, target.timeoutMs ?? CHROME_CLOSE_TIMEOUT_MS));
  while (Date.now() < deadline) {
    if (!(await browserProcessIds(tasklist, target.imageName)).length) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, CHROME_EXIT_POLL_MS));
  }
  if (closeRequestFailed) {
    throw new Error('Browser close request failed.');
  }
  throw new Error('Google Chrome이 정상 종료되지 않아 가져오기를 중단했습니다. 열린 작업을 확인한 뒤 다시 시도하세요.');
}
