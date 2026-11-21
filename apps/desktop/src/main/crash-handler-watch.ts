import { type ChildProcess, spawn } from 'node:child_process';
import { join } from 'node:path';

/** Chromium's Crashpad client publishes the handler's registration pipe in this variable. Once the handler is gone
 *  the pipe is gone too: a child still carrying the name is killed with 0xFFFF7003 ("not connected") on its first fatal error. */
export const CRASHPAD_PIPE_ENV = 'CHROME_CRASHPAD_PIPE_NAME';

export type CrashHandlerWatchEvent =
  | { state: 'watching'; handlerPid: number }
  | { state: 'lost'; handlerPid: number | null; reason: 'missing' | 'exited'; pipeCleared: boolean }
  | { state: 'watch-failed'; reason: string };

export interface CrashHandlerWatchOptions {
  mainPid: number;
  onEvent: (event: CrashHandlerWatchEvent) => void;
  /** Environment later children inherit; the dead pipe is removed from it. */
  env?: NodeJS.ProcessEnv;
  /** Liveness poll interval of the in-process check. */
  pollMs?: number;
  /** Test seams; production runs the finder in Windows PowerShell and probes
   *  liveness with signal 0. */
  spawnFinder?: (script: string) => ChildProcess;
  isAlive?: (pid: number) => boolean;
}

const DEFAULT_POLL_MS = 5_000;

/** Node cannot enumerate processes, so a one-shot finder names the
 *  `--type=crashpad-handler` child of the main process and exits. */
export function crashHandlerFinderScript(mainPid: number): string {
  const pid = Math.trunc(mainPid);
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('Main process id is invalid.');
  return `
$ErrorActionPreference = 'Stop'
$main = [System.Diagnostics.Process]::GetProcessById(${pid})
$image = "$($main.ProcessName).exe"
$handler = Get-CimInstance Win32_Process -Filter "ParentProcessId = ${pid}" |
  Where-Object { $_.Name -eq $image -and $_.CommandLine -like '*--type=crashpad-handler*' } |
  Select-Object -First 1
if ($handler) { [Console]::Out.WriteLine("found $($handler.ProcessId)") } else { [Console]::Out.WriteLine('missing') }
`;
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but denies signals — still alive.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function spawnPowerShell(script: string): ChildProcess {
  const systemRoot = String(process.env.SystemRoot || 'C:\\Windows');
  const powershell = join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  return spawn(
    powershell,
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
    { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }
  );
}

/** Removes the dead pipe name from `env` before a loss is reported, so later children start without a Crashpad
 *  client and a fatal error reaches Windows' own handler instead of a silent 0xFFFF7003 kill. Returns `stop`. */
export function watchCrashHandler({
  mainPid,
  onEvent,
  env = process.env,
  pollMs = DEFAULT_POLL_MS,
  spawnFinder = spawnPowerShell,
  isAlive = processAlive,
}: CrashHandlerWatchOptions): () => void {
  let settled = false;
  let stopped = false;
  let poll: NodeJS.Timeout | null = null;
  const finish = (event: CrashHandlerWatchEvent) => {
    if (settled || stopped) return;
    settled = true;
    if (poll) clearInterval(poll);
    poll = null;
    onEvent(event);
  };
  const lose = (handlerPid: number | null, reason: 'missing' | 'exited') => {
    if (settled || stopped) return;
    const pipeCleared = Boolean(env[CRASHPAD_PIPE_ENV]);
    delete env[CRASHPAD_PIPE_ENV];
    finish({ state: 'lost', handlerPid, reason, pipeCleared });
  };
  const watch = (handlerPid: number) => {
    if (settled || stopped) return;
    if (!isAlive(handlerPid)) {
      lose(handlerPid, 'missing');
      return;
    }
    onEvent({ state: 'watching', handlerPid });
    poll = setInterval(() => {
      if (!isAlive(handlerPid)) lose(handlerPid, 'exited');
    }, pollMs);
    poll.unref();
  };
  let finder: ChildProcess;
  try {
    finder = spawnFinder(crashHandlerFinderScript(mainPid));
  } catch (error) {
    finish({ state: 'watch-failed', reason: error instanceof Error ? error.message : String(error) });
    return () => {};
  }
  let output = '';
  finder.stdout?.setEncoding('utf8');
  finder.stdout?.on('data', (chunk: string) => {
    output += chunk;
  });
  finder.once('error', (error) => {
    finish({ state: 'watch-failed', reason: error.message });
  });
  finder.once('close', (code, signal) => {
    const [kind, pid] = output.trim().split(/\s+/);
    if (kind === 'found' && Number(pid) > 0) watch(Number(pid));
    else if (kind === 'missing') lose(null, 'missing');
    else finish({ state: 'watch-failed', reason: `finder exited code=${code ?? '-'} signal=${signal ?? '-'}` });
  });
  return () => {
    stopped = true;
    if (poll) clearInterval(poll);
    poll = null;
    if (finder.exitCode === null && finder.signalCode === null) finder.kill();
  };
}
