// The scripted turns of the read-only I/O deadline recording (record-read-only-deadline.mjs) and its replay on the Rust core
// (replay-read-only-deadline.mjs): one definition, so both sides are given the same model replies, workspace and environment.
//
// A read-only I/O call is held past its deadline by a batch oplock on `slow.txt` (OPLOCK_HOLDER, a helper started before the turn):
// opening the file for reading waits for the holder to acknowledge the break, which it never does; it lets go when its stdin ends,
// after the turn. A stat of the file is not held (an attribute-only open does not break the oplock), so the call reaches its read.
// `env` is laid over the process environment of the side that runs the turn (Node's process, the core).
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';

export const MODEL = 'fake-model';
export const FILES = {
  'a.txt': 'hello\nsecond line\n',
  'slow.txt': 'held behind an oplock\n',
};
export const HELD_FILE = 'slow.txt';

// Windows PowerShell: takes a batch oplock (FSCTL_REQUEST_BATCH_OPLOCK) on the file it is given, writes `held` once the request is
// pending (granted) or `failed <code>` otherwise, and keeps it until its stdin ends; its exit closes the handle and frees the openers.
export const OPLOCK_HOLDER = `param([string]$Path)
$src = @"
using System; using System.Runtime.InteropServices; using System.Threading;
public static class Oplock {
  [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)]
  static extern IntPtr CreateFileW(string name, uint access, uint share, IntPtr sa, uint disp, uint flags, IntPtr tmpl);
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern bool DeviceIoControl(IntPtr h, uint code, IntPtr inb, uint inl, IntPtr outb, uint outl, IntPtr ret, ref NativeOverlapped ov);
  static ManualResetEvent signal = new ManualResetEvent(false);
  public static int Hold(string path) {
    IntPtr h = CreateFileW(path, 0x80000000, 7, IntPtr.Zero, 3, 0x40000000, IntPtr.Zero);
    if (h == new IntPtr(-1)) return Marshal.GetLastWin32Error();
    var ov = new NativeOverlapped();
    ov.EventHandle = signal.SafeWaitHandle.DangerousGetHandle();
    if (DeviceIoControl(h, 0x90008, IntPtr.Zero, 0, IntPtr.Zero, 0, IntPtr.Zero, ref ov)) return -1;
    int err = Marshal.GetLastWin32Error();
    return err == 997 ? 0 : err;
  }
}
"@
Add-Type -TypeDefinition $src
$code = [Oplock]::Hold($Path)
if ($code -eq 0) { [Console]::Out.WriteLine('held') } else { [Console]::Out.WriteLine("failed $code") }
[Console]::Out.Flush()
[void][Console]::In.ReadToEnd()
`;

const deadline = (p, ms, what) => {
  let timer;
  return Promise.race([p, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${what} did not finish within ${ms} ms`)), ms); })]).finally(() => clearTimeout(timer));
};

/**
 * Starts OPLOCK_HOLDER on `file` (its script written to `scriptPath`), hidden, and resolves once it holds the oplock. `release()` ends
 * its stdin and resolves when it has exited (the oplock is gone then).
 */
export async function holdOplock(file, scriptPath) {
  writeFileSync(scriptPath, OPLOCK_HOLDER);
  const holder = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, '-Path', file], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const exited = new Promise((resolve) => holder.once('exit', resolve));
  let out = '';
  let err = '';
  holder.stderr.on('data', (d) => { err += d; });
  try {
    await deadline(new Promise((resolve, reject) => {
      holder.stdout.on('data', (d) => {
        out += d;
        if (!out.includes('\n')) return;
        if (out.startsWith('held')) resolve();
        else reject(new Error(`the oplock holder: ${out.trim()} ${err}`));
      });
      holder.once('exit', (code) => reject(new Error(`the oplock holder exited (${code}) before holding: ${out} ${err}`)));
    }), 60_000, 'the oplock holder taking its oplock');
  } catch (error) {
    holder.kill();
    await deadline(exited, 30_000, 'the oplock holder ending after its kill');
    throw error;
  }
  return {
    release() {
      holder.stdin.end();
      return deadline(exited, 30_000, 'the oplock holder exiting');
    },
  };
}

const DONE = { text: 'done', calls: [] };

export function scenarios() {
  return [
    {
      // A read held past a configured deadline, beside a read that is not held.
      name: 'a read held past a 3000 ms deadline',
      env: { MIXDOG_IO_TOOL_TIMEOUT_MS: '3000' },
      replies: [
        {
          text: 'go',
          calls: [
            { id: 'r1', name: 'read', args: { path: HELD_FILE } },
            { id: 'r2', name: 'read', args: { path: 'a.txt' } },
          ],
        },
        DONE,
      ],
    },
    {
      // No MIXDOG_IO_TOOL_TIMEOUT_MS: the default deadline.
      name: 'a read held past the default deadline',
      env: {},
      replies: [{ text: 'go', calls: [{ id: 'd1', name: 'read', args: { path: HELD_FILE } }] }, DONE],
    },
  ];
}
