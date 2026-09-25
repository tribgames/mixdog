/**
 * The resident PowerShell workers: publishing the host script, caching its
 * compiled types per build, keeping one worker warm, routing requests, and the
 * one-shot elevated path for targets a normal worker cannot reach. The pool
 * owns worker state; the host tells it whether the bridge is still wanted.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { powershellHostProgram, RESPONSE_MARKER } from './program';
import { elevatedProgramInvocation } from './elevated-program';
import { computerNativeBinary, computerNativeEnvironment } from './native-host';
import { createSessionJobs } from './session-jobs';
import { recordCursorDiagnostic } from '../overlay/cursor-diagnostics';
import { assertComputerWorkerCapacity, MAX_COMPUTER_WORKERS } from './worker-capacity';
import type { PowerShellResponse } from '../shared/types';
import { captureCleanup } from '../shared/capture-attempts';
import { computerActionHas } from '../../../../../../src/runtime/computer-bridge/actions.mjs';
import {
  createComputerLineDecoder,
  MAX_COMPUTER_INTERNAL_REQUEST_BYTES,
} from '../../../../../../src/runtime/computer-bridge/limits.mjs';

/** Per-command ceiling for the PowerShell host round trip. */
const COMMAND_TIMEOUT_MS = 45_000;
// build pays the C# compile; every later worker loads the cached assembly.
const HOST_ASSEMBLY_CACHE_DIRECTORY = 'host-cache';

/** Actions whose worker streams pointer progress back while they run. */
const POINTER_FEEDBACK_ACTIONS = [
  'click',
  'invoke',
  'set_value',
  'toggle',
  'double_click',
  'right_click',
  'middle_click',
  'triple_click',
  'mouse_down',
  'mouse_up',
  'mouse_move',
  'drag',
  'scroll',
  'key',
  'key_down',
  'key_up',
  'type',
];

/** Progress phases a pointer event may claim; anything else is not a phase
 *  this build emits and is counted as invalid rather than reported. */
const POINTER_PROGRESS_PHASES = ['move', 'prepare', 'press', 'release', 'drag', 'scroll', 'type'];

/** One in-flight worker request, from dispatch to its reply, timeout or the
 *  retirement of the worker that owns it. */
interface PendingWorkerRequest {
  resolve: (r: PowerShellResponse) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
  child: ChildProcessWithoutNullStreams;
  sessionId: string;
  pointerFeedback: boolean;
  windowId?: string;
  mode: 'background' | 'foreground';
  input: boolean;
  backgroundPressRelease: boolean;
}

/** What one request is, as the pool has to treat it: whose session it belongs
 *  to, whether it can leave input held, and whether the host streams pointer
 *  progress for it. Derived from the request alone — a sequence step is read
 *  through its envelope, exactly as the host dispatches it. */
function classifyWorkerRequest(request: Record<string, unknown>): {
  sessionId: string;
  windowId?: string;
  mode: 'background' | 'foreground';
  input: boolean;
  backgroundPressRelease: boolean;
  pointerAction: boolean;
} {
  const step = request.step as Record<string, unknown> | undefined;
  const inputAction = request.action === 'sequence_step' ? step?.action : request.action;
  const target = request.action === 'sequence_step' ? step : request;
  return {
    sessionId: String(request.session_id || 'default'),
    windowId: typeof target?.window_id === 'string' ? target.window_id : undefined,
    mode: request.delivery === 'foreground' ? 'foreground' : 'background',
    input:
      !computerActionHas(String(inputAction), 'nativeRead') &&
      inputAction !== 'release_session' &&
      inputAction !== 'release_cursor_theme',
    backgroundPressRelease:
      computerActionHas(String(inputAction), 'backgroundPressRelease') ||
      (inputAction === 'type' &&
        ((target?.x != null && target?.y != null) || String(target?.text ?? '').includes('\n'))),
    pointerAction: POINTER_FEEDBACK_ACTIONS.includes(String(inputAction)),
  };
}

/** A pointer-progress line, reported only when it matches a request that asked
 *  for feedback and carries a phase and coordinates this build understands.
 *  Every rejection is counted, so a silent cursor has a reason on record. */
function reportPointerProgress(
  payload: string,
  requestOf: (id: unknown) => PendingWorkerRequest | undefined,
  onPointerProgress: WorkerPoolHost['onPointerProgress']
): void {
  recordCursorDiagnostic('received');
  try {
    const event = JSON.parse(payload);
    const entry = requestOf(event.id);
    if (
      entry?.pointerFeedback &&
      Number.isFinite(event.x) &&
      Number.isFinite(event.y) &&
      typeof event.held === 'boolean'
    ) {
      const phase = event.phase ?? (event.held ? 'drag' : 'move');
      if (POINTER_PROGRESS_PHASES.includes(phase)) {
        recordCursorDiagnostic('validated');
        onPointerProgress?.(entry.sessionId, event.x, event.y, event.held, entry.mode, phase, entry.windowId);
      } else recordCursorDiagnostic('invalid_phase');
    } else recordCursorDiagnostic('discarded_event');
  } catch {
    recordCursorDiagnostic('event_handler_failed');
  }
}

/** The launcher that raises one elevated worker: it re-publishes this process's
 *  environment into the elevated child (which inherits none of it through the
 *  UAC boundary) and runs the bootstrap through -EncodedCommand. */
function elevatedLauncherCommand(): string {
  const bootstrapEncoded = Buffer.from(elevatedProgramInvocation(), 'utf16le').toString('base64');
  return [
    "$ErrorActionPreference = 'Stop'",
    "$powershell = Join-Path $PSHOME 'powershell.exe'",
    `$bootstrap = [Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('${bootstrapEncoded}'))`,
    'function ConvertTo-MixdogLiteral([string]$value) { return "\'" + $value.Replace("\'", "\'\'") + "\'" }',
    '$env:MIXDOG_ELEVATED_PARENT_PID = [string]$PID',
    '$env:MIXDOG_ELEVATED_PARENT_TICKS = [string]([Diagnostics.Process]::GetCurrentProcess().StartTime.ToUniversalTime().Ticks)',
    "$variableNames = @('MIXDOG_ELEVATED_TOKEN','MIXDOG_ELEVATED_HOST_SCRIPT','MIXDOG_ELEVATED_HOST_SHA256','MIXDOG_ELEVATED_REQUEST','MIXDOG_ELEVATED_REQUEST_SHA256','MIXDOG_ELEVATED_RESPONSE','MIXDOG_ELEVATED_CANCEL','MIXDOG_ELEVATED_MARKER','MIXDOG_ELEVATED_PARENT_PID','MIXDOG_ELEVATED_PARENT_TICKS','MIXDOG_COMPUTER_INPUT_MARKER')",
    "$prelude = @($variableNames | ForEach-Object { '$env:' + $_ + ' = ' + (ConvertTo-MixdogLiteral ([string][Environment]::GetEnvironmentVariable($_))) }) -join [Environment]::NewLine",
    '$elevatedScript = $prelude + [Environment]::NewLine + $bootstrap',
    '$elevatedEncoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($elevatedScript))',
    "if ($elevatedEncoded.Length -gt 30000) { throw 'privileged_worker_unavailable: launch configuration exceeds Windows command line capacity' }",
    "$arguments = @('-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-EncodedCommand',$elevatedEncoded)",
    'try {',
    '  $process = Start-Process -FilePath $powershell -Verb RunAs -ArgumentList $arguments -Wait -PassThru',
    '  exit $process.ExitCode',
    '} catch {',
    "  [Console]::Error.WriteLine(('launcher_error:' + $_.Exception.Message))",
    '  exit 1223',
    '}',
  ].join('; ');
}

/** Runs the launcher to completion, keeping a bounded tail of both streams. At
 *  the deadline it asks the elevated child to cancel and only then kills the
 *  launcher, so a refused cancellation is reported as unconfirmed cleanup. */
function runElevatedLauncher(options: {
  spawnProcess: typeof spawn;
  launcher: string;
  env: NodeJS.ProcessEnv;
  cancel: () => void;
  onSpawnFailure: () => void;
}): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = options.spawnProcess(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', options.launcher],
      {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: options.env,
      }
    );
    let stdout = '';
    let stderr = '';
    const appendBounded = (current: string, chunk: Buffer): string =>
      `${current}${chunk.toString('utf8')}`.slice(-4096);
    child.stdout.on('data', (chunk: Buffer) => {
      stdout = appendBounded(stdout, chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = appendBounded(stderr, chunk);
    });
    let cleanupTimer: NodeJS.Timeout | undefined;
    const timer = setTimeout(() => {
      try {
        options.cancel();
      } catch {
        /* parent death also cancels the input child */
      }
      cleanupTimer = setTimeout(() => {
        try {
          child.kill();
        } catch {
          /* launcher already exited */
        }
        reject(new Error('privileged_worker_cleanup_unconfirmed: elevated input did not acknowledge cancellation'));
      }, 6_000);
    }, 120_000);
    child.once('error', (error) => {
      clearTimeout(timer);
      if (cleanupTimer) clearTimeout(cleanupTimer);
      if (!child.pid) options.onSpawnFailure();
      reject(error);
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      if (cleanupTimer) clearTimeout(cleanupTimer);
      resolve({
        code: Number(code ?? 1),
        stdout,
        stderr,
      });
    });
  });
}

/** No response file: why, and whether the worker is known to have stopped.
 *  UAC refusal is the one failure that also confirms termination. */
function elevatedLauncherFailure(result: { code: number; stdout: string; stderr: string }): {
  cancelled: boolean;
  error: Error;
} {
  const launcherDetail = `${result.stderr}\n${result.stdout}`.trim().replace(/\s+/g, ' ').slice(0, 1000);
  if (result.code === 1223) {
    return { cancelled: true, error: new Error('privileged_worker_cancelled: UAC consent was declined') };
  }
  if (result.code === 0) {
    return {
      cancelled: false,
      error: new Error('privileged_worker_unavailable: elevated worker returned no response'),
    };
  }
  return {
    cancelled: false,
    error: new Error(
      `privileged_worker_launcher_failed: elevated worker exited with code ${result.code}` +
        (launcherDetail ? ` (${launcherDetail})` : '')
    ),
  };
}

/** Authenticates the response envelope against this run's nonce and its
 *  termination receipt, returning the response line it wraps. */
function assertElevatedReceipt(envelope: string, nonce: string): string {
  const newline = envelope.indexOf('\n');
  const responseToken = (newline >= 0 ? envelope.slice(0, newline) : envelope)
    .replace(/^\uFEFF/, '')
    .replace(/\r$/, '');
  const receipt =
    newline >= 0
      ? envelope
          .slice(newline + 1)
          .trim()
          .split(/\r?\n/)
      : [];
  const responseLine = receipt.slice(1).join('\n');
  if (responseToken !== nonce) {
    throw new Error('privileged_worker_rejected: response authentication failed');
  }
  if (receipt[0] !== 'STOPPED') {
    throw new Error('privileged_worker_cleanup_unconfirmed: elevated worker did not confirm termination');
  }
  return responseLine;
}

/** The structured reply inside an authenticated envelope, proven to answer the
 *  request that was sent. */
function parseElevatedResponse(responseLine: string, id: number): PowerShellResponse {
  if (responseLine.startsWith('ERROR:')) {
    throw new Error(`privileged_worker_failed: ${responseLine.slice(6)}`);
  }
  const marker = responseLine.indexOf(RESPONSE_MARKER);
  if (marker < 0) throw new Error('privileged_worker_failed: structured response is missing');
  const parsed = JSON.parse(responseLine.slice(marker + RESPONSE_MARKER.length)) as PowerShellResponse;
  if (parsed.id !== id) throw new Error('privileged_worker_rejected: response id mismatch');
  return parsed;
}

export interface WorkerPoolHost {
  /** Where the host script and its assembly cache belong. */
  dataDirectory(): string;
  /** A spare is only worth keeping while the bridge would use it. */
  isBridgeEnabled(): boolean;
  isDisposed(): boolean;
  onSessionRetired?(sessionId: string, child: ChildProcessWithoutNullStreams, interruptedInput: boolean): void;
  maxWorkers?: number;
  onPointerProgress?(
    sessionId: string,
    x: number,
    y: number,
    held: boolean,
    mode: 'background' | 'foreground',
    phase: string,
    windowId?: string
  ): void;
  /** Launch-time facts the native backend needs from the app (macOS/Linux). */
  nativeEnvironment?(): Record<string, string>;
  /** Injectable process transport for isolated lifecycle tests. */
  spawnProcess?: typeof spawn;
}

export function createWorkerPool(host: WorkerPoolHost) {
  const { dataDirectory, onSessionRetired } = host;

  let hostScriptPath: string | null = null;
  let hostScriptBuild = '';
  let nextId = 1;
  const pending = new Map<number, PendingWorkerRequest>();
  const powerShellBySession = new Map<string, ChildProcessWithoutNullStreams>();
  const workerLastUsedAt = new Map<string, number>();
  const hostWorkers = new Set<ChildProcessWithoutNullStreams>();
  // A killed message sender has no receipt proving that its finally block ran.
  // Keep this uncertainty latched even after the child and observation are gone.
  const unconfirmedBackgroundSessions = new Set<string>();
  const elevatedJobs = createSessionJobs();
  const maxWorkers = host.maxWorkers ?? MAX_COMPUTER_WORKERS;
  const spawnProcess = host.spawnProcess || spawn;
  assertComputerWorkerCapacity(0, maxWorkers);
  let elevatedSlots = 0;
  const inputMarker = String(randomBytes(4).readUInt32LE() & 0x7fffffff || 1);
  const hostScriptName = `computer-host-${process.pid}-${randomBytes(12).toString('hex')}.ps1`;
  const processAlive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      // EPERM: the process exists but belongs to someone else.
      return (error as NodeJS.ErrnoException).code === 'EPERM';
    }
  };

  function ensureHostScript(): string {
    if (hostScriptPath) return hostScriptPath;
    const directory = dataDirectory();
    mkdirSync(directory, { recursive: true });
    const program = powershellHostProgram();
    hostScriptBuild = createHash('sha256').update(program).digest('hex').slice(0, 16);
    hostScriptPath = join(directory, hostScriptName);
    writeFileSync(hostScriptPath, program);
    removeOrphanedHostScripts(directory);
    try {
      const cacheDirectory = join(directory, HOST_ASSEMBLY_CACHE_DIRECTORY);
      mkdirSync(cacheDirectory, { recursive: true });
      const current = `mixdog-computer-host-${hostScriptBuild}.dll`;
      for (const name of readdirSync(cacheDirectory)) {
        if (name === current) continue;
        try {
          unlinkSync(join(cacheDirectory, name));
        } catch {
          /* a live worker holds it */
        }
      }
    } catch {
      /* the cache is an optimization, never a requirement */
    }
    return hostScriptPath;
  }

  /** An exited worker keeps its slot until its `exit` event arrives, and a
   * confirmed session release can outrun that event. Dead children are pruned
   * before the limit is judged so a finished session never blocks the next. */
  function liveWorkerCount(): number {
    for (const child of hostWorkers) {
      if (child.exitCode !== null || child.signalCode !== null) hostWorkers.delete(child);
    }
    return hostWorkers.size;
  }

  /** Windows runs the PowerShell host program; macOS and Linux run the
   *  native backend, which speaks the same line protocol. */
  function spawnHostProcess(): ChildProcessWithoutNullStreams {
    if (process.platform !== 'win32') {
      return spawnProcess(computerNativeBinary(), [], {
        env: computerNativeEnvironment(inputMarker, host.nativeEnvironment?.()),
      });
    }
    // The program runs from a temp .ps1 via -File, NOT piped through -Command -:
    // with -Command - PowerShell consumes stdin as the command text, colliding
    // with the per-command JSON we also write to stdin. -File leaves stdin
    // dedicated to runtime commands.
    const scriptPath = ensureHostScript();
    return spawnProcess(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath],
      {
        windowsHide: true,
        env: {
          ...process.env,
          MIXDOG_COMPUTER_HOST_CACHE: join(dataDirectory(), HOST_ASSEMBLY_CACHE_DIRECTORY),
          MIXDOG_COMPUTER_HOST_BUILD: hostScriptBuild,
          MIXDOG_COMPUTER_INPUT_MARKER: inputMarker,
        },
      }
    );
  }

  function spawnHostWorker(): ChildProcessWithoutNullStreams {
    elevatedJobs.assertClear();
    assertComputerWorkerCapacity(liveWorkerCount() + elevatedSlots, maxWorkers);
    const child = spawnHostProcess();
    hostWorkers.add(child);
    const receive = createComputerLineDecoder((line) => {
      if (line.startsWith('@@MIXDOG_POINTER@@')) {
        reportPointerProgress(
          line.slice('@@MIXDOG_POINTER@@'.length),
          (id) => {
            const entry = pending.get(id as number);
            // Only this worker's own requests: a reused id from a retired
            // worker names a request this line knows nothing about.
            return entry?.child === child ? entry : undefined;
          },
          host.onPointerProgress
        );
        return;
      }
      const marker = line.indexOf(RESPONSE_MARKER);
      if (marker >= 0) handlePsLine(line.slice(marker + RESPONSE_MARKER.length), child);
    });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      try {
        receive(chunk);
      } catch (error) {
        retirePowerShell(child, error instanceof Error ? error : new Error(String(error)));
      }
    });
    child.stderr.on('data', () => {
      /* diagnostics ignored; errors ride responses */
    });
    child.stdin.once('error', (error) => {
      retirePowerShell(child, new Error(`computer host input channel failed: ${error.message}`));
    });
    child.once('error', (error) => {
      if (!child.pid) hostWorkers.delete(child);
      retirePowerShell(child, new Error(`computer host failed to start: ${error.message}`));
    });
    child.once('exit', () => {
      hostWorkers.delete(child);
      retirePowerShell(child, new Error('computer host exited'));
    });
    return child;
  }

  function ensurePowerShell(sessionId: string): ChildProcessWithoutNullStreams {
    elevatedJobs.assertClear();
    const existing = powerShellBySession.get(sessionId);
    if (existing && !existing.killed) {
      workerLastUsedAt.set(sessionId, Date.now());
      return existing;
    }
    const child = spawnHostWorker();
    powerShellBySession.set(sessionId, child);
    workerLastUsedAt.set(sessionId, Date.now());
    return child;
  }

  function retirePowerShell(child: ChildProcessWithoutNullStreams, error: Error): void {
    const retiredSessionIds: string[] = [];
    let interruptedInput = false;
    for (const [sessionId, activeChild] of powerShellBySession) {
      if (activeChild !== child) continue;
      powerShellBySession.delete(sessionId);
      workerLastUsedAt.delete(sessionId);
      retiredSessionIds.push(sessionId);
    }
    for (const [id, entry] of pending) {
      if (entry.child !== child) continue;
      if (entry.input) {
        interruptedInput = true;
        // An uncertain mutation is not necessarily an unacknowledged key/button
        // release. Semantic actions and WM_CHAR alone cannot leave one held.
        if (entry.mode === 'background' && entry.backgroundPressRelease) {
          unconfirmedBackgroundSessions.add(entry.sessionId);
        }
      }
      clearTimeout(entry.timer);
      entry.reject(error);
      pending.delete(id);
    }
    if (!child.killed && child.exitCode === null && child.signalCode === null) {
      try {
        child.kill();
      } catch {
        /* exit confirmation belongs to the lifecycle */
      }
    }
    for (const sessionId of retiredSessionIds) {
      try {
        onSessionRetired?.(sessionId, child, interruptedInput);
      } catch {
        /* failed cleanup stays latched */
      }
    }
  }

  function handlePsLine(json: string, child: ChildProcessWithoutNullStreams): void {
    let parsed: PowerShellResponse;
    try {
      parsed = JSON.parse(json) as PowerShellResponse;
    } catch {
      return;
    }
    const entry = pending.get(parsed.id);
    if (!entry || entry.child !== child) return;
    if (entry.input && entry.mode === 'background' && /input_cleanup_unconfirmed/.test(String(parsed.error || ''))) {
      unconfirmedBackgroundSessions.add(entry.sessionId);
    }
    const feedback = (
      parsed as PowerShellResponse & {
        pointer_feedback?: { generated: number; failed: number };
      }
    ).pointer_feedback;
    if (entry.pointerFeedback) {
      recordCursorDiagnostic('tracked_requests');
      if (feedback) {
        recordCursorDiagnostic('source_generated', feedback.generated);
        recordCursorDiagnostic('source_failed', feedback.failed);
      } else recordCursorDiagnostic('source_summary_missing');
    }
    clearTimeout(entry.timer);
    pending.delete(parsed.id);
    const cleanup = captureCleanup(parsed.result?.capture_cleanup);
    if (!entry.input && cleanup && cleanup.status !== 'confirmed') {
      // Unpublish before resolving: a caller may issue its next request before
      // the worker's exit event arrives. Preserve this reply's original cause.
      retirePowerShell(child, new Error('capture_cleanup_unconfirmed: capture worker must retire'));
    }
    entry.resolve(parsed);
  }

  function callPowerShell(
    request: Record<string, unknown>,
    timeoutMs = COMMAND_TIMEOUT_MS
  ): Promise<PowerShellResponse> {
    const classified = classifyWorkerRequest(request);
    const sessionId = classified.sessionId;
    const id = nextId++;
    const pointerFeedback = classified.pointerAction && Boolean(host.onPointerProgress);
    const line = `${JSON.stringify({ ...request, id, pointer_feedback: pointerFeedback })}\n`;
    if (pending.size >= 32 || Buffer.byteLength(line) > MAX_COMPUTER_INTERNAL_REQUEST_BYTES) {
      return Promise.reject(
        new Error('computer_capacity_exhausted: worker request budget exceeded; input was not dispatched')
      );
    }
    const child = ensurePowerShell(sessionId);
    const commandTimeoutMs = Number.isFinite(timeoutMs)
      ? Math.max(50, Math.min(COMMAND_TIMEOUT_MS, Math.round(timeoutMs)))
      : COMMAND_TIMEOUT_MS;
    return new Promise<PowerShellResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        retirePowerShell(
          child,
          new Error(`computer_command_timeout: command exceeded ${commandTimeoutMs}ms; the input host was restarted`)
        );
      }, commandTimeoutMs);
      pending.set(id, {
        resolve,
        reject,
        timer,
        child,
        sessionId,
        pointerFeedback,
        windowId: classified.windowId,
        mode: classified.mode,
        input: classified.input,
        backgroundPressRelease: classified.backgroundPressRelease,
      });
      try {
        child.stdin.write(line);
      } catch (error) {
        retirePowerShell(child, error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  async function callPowerShellElevated(request: Record<string, unknown>): Promise<PowerShellResponse> {
    const sessionId = String(request.session_id || 'default');
    ensurePowerShell(sessionId);
    if (!hostScriptPath) throw new Error('privileged_worker_unavailable: computer host script is missing');
    const directory = dataDirectory();
    mkdirSync(directory, { recursive: true });
    assertComputerWorkerCapacity(liveWorkerCount() + elevatedSlots + 2, maxWorkers);
    const nonce = randomBytes(24).toString('base64url');
    const requestPath = join(directory, `computer-elevated-${nonce}.request.json`);
    const responsePath = join(directory, `computer-elevated-${nonce}.response.txt`);
    const cancelPath = join(directory, `computer-elevated-${nonce}.cancel`);
    const id = nextId++;
    const requestBytes = Buffer.from(`${JSON.stringify({ ...request, id })}\n`, 'utf8');
    const hostBytes = readFileSync(hostScriptPath);
    const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
    writeFileSync(requestPath, requestBytes, {
      encoding: 'utf8',
      mode: 0o600,
    });
    const launcher = elevatedLauncherCommand();
    let stopped = false;
    const cancel = () => writeFileSync(cancelPath, nonce, { mode: 0o600 });
    const job = elevatedJobs.begin(sessionId, cancel);
    elevatedSlots += 3;
    try {
      const launcherResult = await runElevatedLauncher({
        spawnProcess,
        launcher,
        env: {
          ...process.env,
          MIXDOG_ELEVATED_TOKEN: nonce,
          MIXDOG_COMPUTER_INPUT_MARKER: inputMarker,
          MIXDOG_ELEVATED_HOST_SCRIPT: hostScriptPath,
          MIXDOG_ELEVATED_HOST_SHA256: sha256(hostBytes),
          MIXDOG_ELEVATED_REQUEST: requestPath,
          MIXDOG_ELEVATED_REQUEST_SHA256: sha256(requestBytes),
          MIXDOG_ELEVATED_RESPONSE: responsePath,
          MIXDOG_ELEVATED_CANCEL: cancelPath,
          MIXDOG_ELEVATED_MARKER: RESPONSE_MARKER,
        },
        cancel,
        onSpawnFailure: () => {
          stopped = true;
        },
      });
      let envelope = '';
      try {
        envelope = readFileSync(responsePath, 'utf8');
      } catch {
        const failure = elevatedLauncherFailure(launcherResult);
        if (failure.cancelled) stopped = true;
        throw failure.error;
      }
      const responseLine = assertElevatedReceipt(envelope, nonce);
      stopped = true;
      return parseElevatedResponse(responseLine, id);
    } finally {
      job.finish(stopped);
      if (stopped) elevatedSlots -= 3;
      try {
        unlinkSync(requestPath);
      } catch {
        /* already removed */
      }
      try {
        unlinkSync(responsePath);
      } catch {
        /* no response on UAC cancellation */
      }
      if (stopped) {
        try {
          unlinkSync(cancelPath);
        } catch {
          /* no cancellation requested */
        }
      }
    }
  }

  /** A host that crashed or was killed never ran removeHostScript, so its
   *  script outlives it; one whose process is gone is safe to delete. */
  function removeOrphanedHostScripts(directory: string): void {
    let names: string[] = [];
    try {
      names = readdirSync(directory);
    } catch {
      return;
    }
    for (const name of names) {
      const match = /^computer-host-(\d+)-[0-9a-f]+\.ps1$/.exec(name);
      if (!match || name === hostScriptName || processAlive(Number(match[1]))) continue;
      try {
        unlinkSync(join(directory, name));
      } catch {
        /* removed concurrently */
      }
    }
  }

  /** The published script is a temp artifact; it goes when the host does. */
  function removeHostScript(): void {
    if (hostScriptPath) {
      try {
        unlinkSync(hostScriptPath);
      } catch {
        /* already gone */
      }
    }
    hostScriptPath = null;
  }

  function residentWorkerPids(): number[] {
    return [...hostWorkers]
      .filter((child) => child.exitCode === null && child.signalCode === null)
      .map((child) => Number(child.pid))
      .filter((pid) => Number.isInteger(pid) && pid > 0);
  }

  /** Resolves true once no resident worker is alive; false at the deadline. */
  function waitForResidentWorkersExit(timeoutMs: number): Promise<boolean> {
    return new Promise((resolve) => {
      const deadline = Date.now() + timeoutMs;
      const check = () => {
        if (residentWorkerPids().length === 0) {
          resolve(true);
          return;
        }
        if (Date.now() >= deadline) {
          resolve(false);
          return;
        }
        setTimeout(check, 100).unref?.();
      };
      check();
    });
  }

  return {
    inputMarker,
    powerShellBySession,
    workerLastUsedAt,
    residentWorkerPids,
    waitForResidentWorkersExit,
    removeHostScript,
    ensureHostScript,
    ensurePowerShell,
    retirePowerShell,
    hasUnconfirmedBackgroundInput: (sessionId?: string) =>
      sessionId === undefined ? unconfirmedBackgroundSessions.size > 0 : unconfirmedBackgroundSessions.has(sessionId),
    callPowerShell,
    callPowerShellElevated,
    cancelElevatedSession: elevatedJobs.cancel,
    elevatedSessionIds: elevatedJobs.sessionIds,
  };
}
