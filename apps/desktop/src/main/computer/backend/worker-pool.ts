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
import { createSessionJobs } from './session-jobs';
import { assertComputerWorkerCapacity, MAX_COMPUTER_WORKERS } from './worker-capacity';
import type { PowerShellResponse } from '../shared/types';
import {
  createComputerLineDecoder,
  MAX_COMPUTER_INTERNAL_REQUEST_BYTES,
} from '../../../../../../src/runtime/computer-bridge/limits.mjs';

/** Per-command ceiling for the PowerShell host round trip. */
const COMMAND_TIMEOUT_MS = 45_000;
// build pays the C# compile; every later worker loads the cached assembly.
const HOST_ASSEMBLY_CACHE_DIRECTORY = 'host-cache';

export interface WorkerPoolHost {
  /** Where the host script and its assembly cache belong. */
  dataDirectory(): string;
  /** A spare is only worth keeping while the bridge would use it. */
  isBridgeEnabled(): boolean;
  isDisposed(): boolean;
  onSessionRetired?(sessionId: string, child?: ChildProcessWithoutNullStreams): void;
  maxWorkers?: number;
  /** Injectable process transport for isolated lifecycle tests. */
  spawnProcess?: typeof spawn;
}

export function createWorkerPool(host: WorkerPoolHost) {
  const {
    dataDirectory,
    isBridgeEnabled,
    isDisposed,
    onSessionRetired,
  } = host;

  let hostScriptPath: string | null = null;
  let hostScriptBuild = '';
  // One warm worker waiting to be adopted by the next session that needs one.
  let spareHostWorker: ChildProcessWithoutNullStreams | null = null;
  let nextId = 1;
  const pending = new Map<number, {
    resolve: (r: PowerShellResponse) => void;
    reject: (e: Error) => void;
    timer: NodeJS.Timeout;
    child: ChildProcessWithoutNullStreams;
  }>();
  const powerShellBySession = new Map<string, ChildProcessWithoutNullStreams>();
  const workerLastUsedAt = new Map<string, number>();
  const hostWorkers = new Set<ChildProcessWithoutNullStreams>();
  const elevatedJobs = createSessionJobs();
  const maxWorkers = host.maxWorkers ?? MAX_COMPUTER_WORKERS;
  const spawnProcess = host.spawnProcess || spawn;
  assertComputerWorkerCapacity(0, maxWorkers);
  let elevatedSlots = 0;
  const inputMarker = String((randomBytes(4).readUInt32LE() & 0x7fffffff) || 1);

  function ensureHostScript(): string {
    if (hostScriptPath) return hostScriptPath;
    const directory = dataDirectory();
    mkdirSync(directory, { recursive: true });
    const program = powershellHostProgram();
    hostScriptBuild = createHash('sha256').update(program).digest('hex').slice(0, 16);
    hostScriptPath = join(directory, 'computer-host.ps1');
    writeFileSync(hostScriptPath, program);
    try {
      const cacheDirectory = join(directory, HOST_ASSEMBLY_CACHE_DIRECTORY);
      mkdirSync(cacheDirectory, { recursive: true });
      const current = `mixdog-computer-host-${hostScriptBuild}.dll`;
      for (const name of readdirSync(cacheDirectory)) {
        if (name === current) continue;
        try { unlinkSync(join(cacheDirectory, name)); } catch { /* a live worker holds it */ }
      }
    } catch { /* the cache is an optimization, never a requirement */ }
    return hostScriptPath;
  }

  function spawnHostWorker(): ChildProcessWithoutNullStreams {
    elevatedJobs.assertClear();
    assertComputerWorkerCapacity(hostWorkers.size + elevatedSlots, maxWorkers);
    // The program runs from a temp .ps1 via -File, NOT piped through -Command -:
    // with -Command - PowerShell consumes stdin as the command text, colliding
    // with the per-command JSON we also write to stdin. -File leaves stdin
    // dedicated to runtime commands.
    const scriptPath = ensureHostScript();
    const child = spawnProcess('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath], {
      windowsHide: true,
      env: {
        ...process.env,
        MIXDOG_COMPUTER_HOST_CACHE: join(dataDirectory(), HOST_ASSEMBLY_CACHE_DIRECTORY),
        MIXDOG_COMPUTER_HOST_BUILD: hostScriptBuild,
        MIXDOG_COMPUTER_INPUT_MARKER: inputMarker,
      },
    });
    hostWorkers.add(child);
    const receive = createComputerLineDecoder((line) => {
      const marker = line.indexOf(RESPONSE_MARKER);
      if (marker >= 0) handlePsLine(line.slice(marker + RESPONSE_MARKER.length), child);
    });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      try { receive(chunk); }
      catch (error) { retirePowerShell(child, error instanceof Error ? error : new Error(String(error))); }
    });
    child.stderr.on('data', () => { /* diagnostics ignored; errors ride responses */ });
    child.stdin.once('error', (error) => {
      retirePowerShell(child, new Error(`computer host input channel failed: ${error.message}`));
    });
    child.once('error', (error) => {
      if (!child.pid) hostWorkers.delete(child);
      if (spareHostWorker === child) spareHostWorker = null;
      retirePowerShell(child, new Error(`computer host failed to start: ${error.message}`));
    });
    child.once('exit', () => {
      hostWorkers.delete(child);
      if (spareHostWorker === child) spareHostWorker = null;
      // A worker can be adopted by a session after it spawned, so its identity
      // is looked up rather than captured.
      for (const [id, activeChild] of powerShellBySession) {
        if (activeChild !== child) continue;
        powerShellBySession.delete(id);
        workerLastUsedAt.delete(id);
        try { onSessionRetired?.(id, child); } catch { /* host cleanup is best effort */ }
      }
      for (const [id, entry] of pending) {
        if (entry.child !== child) continue;
        clearTimeout(entry.timer);
        entry.reject(new Error('computer host exited'));
        pending.delete(id);
      }
    });
    return child;
  }

  function ensureSpareHostWorker(): void {
    if (isDisposed() || !isBridgeEnabled() || (spareHostWorker && !spareHostWorker.killed)) return;
    try {
      spareHostWorker = spawnHostWorker();
    } catch {
      spareHostWorker = null;
    }
  }

  function ensurePowerShell(sessionId: string): ChildProcessWithoutNullStreams {
    elevatedJobs.assertClear();
    const existing = powerShellBySession.get(sessionId);
    if (existing && !existing.killed) {
      workerLastUsedAt.set(sessionId, Date.now());
      return existing;
    }
    let child = spareHostWorker && !spareHostWorker.killed ? spareHostWorker : null;
    if (child) spareHostWorker = null;
    else child = spawnHostWorker();
    const refill = setTimeout(() => ensureSpareHostWorker(), 0);
    refill.unref?.();
    powerShellBySession.set(sessionId, child);
    workerLastUsedAt.set(sessionId, Date.now());
    return child;
  }

  function retirePowerShell(child: ChildProcessWithoutNullStreams, error: Error): void {
    const retiredSessionIds: string[] = [];
    for (const [sessionId, activeChild] of powerShellBySession) {
      if (activeChild !== child) continue;
      powerShellBySession.delete(sessionId);
      workerLastUsedAt.delete(sessionId);
      retiredSessionIds.push(sessionId);
    }
    for (const [id, entry] of pending) {
      if (entry.child !== child) continue;
      clearTimeout(entry.timer);
      entry.reject(error);
      pending.delete(id);
    }
    try { child.kill(); } catch { /* already gone */ }
    for (const sessionId of retiredSessionIds) {
      try { onSessionRetired?.(sessionId, child); } catch { /* host cleanup is best effort */ }
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
    clearTimeout(entry.timer);
    pending.delete(parsed.id);
    entry.resolve(parsed);
  }

  function callPowerShell(
    request: Record<string, unknown>,
    timeoutMs = COMMAND_TIMEOUT_MS,
  ): Promise<PowerShellResponse> {
    const sessionId = String(request.session_id || 'default');
    const id = nextId++;
    const line = `${JSON.stringify({ ...request, id })}\n`;
    if (pending.size >= 32 || Buffer.byteLength(line) > MAX_COMPUTER_INTERNAL_REQUEST_BYTES) {
      return Promise.reject(new Error('computer_capacity_exhausted: worker request budget exceeded; input was not dispatched'));
    }
    const child = ensurePowerShell(sessionId);
    const commandTimeoutMs = Number.isFinite(timeoutMs)
      ? Math.max(50, Math.min(COMMAND_TIMEOUT_MS, Math.round(timeoutMs)))
      : COMMAND_TIMEOUT_MS;
    return new Promise<PowerShellResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        retirePowerShell(
          child,
          new Error(`computer_command_timeout: command exceeded ${commandTimeoutMs}ms; the input host was restarted`),
        );
      }, commandTimeoutMs);
      pending.set(id, { resolve, reject, timer, child });
      try {
        child.stdin.write(line);
      } catch (error) {
        retirePowerShell(
          child,
          error instanceof Error ? error : new Error(String(error)),
        );
      }
    });
  }

  async function callPowerShellElevated(
    request: Record<string, unknown>,
  ): Promise<PowerShellResponse> {
    ensurePowerShell(String(request.session_id || 'default'));
    if (!hostScriptPath) throw new Error('privileged_worker_unavailable: computer host script is missing');
    const directory = dataDirectory();
    mkdirSync(directory, { recursive: true });
    assertComputerWorkerCapacity(hostWorkers.size + elevatedSlots + 2, maxWorkers);
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
    const bootstrapEncoded = Buffer.from(elevatedProgramInvocation(), 'utf16le').toString('base64');
    const launcher = [
      "$ErrorActionPreference = 'Stop'",
      "$powershell = Join-Path $PSHOME 'powershell.exe'",
      `$bootstrap = [Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('${bootstrapEncoded}'))`,
      "function ConvertTo-MixdogLiteral([string]$value) { return \"'\" + $value.Replace(\"'\", \"''\") + \"'\" }",
      "$env:MIXDOG_ELEVATED_PARENT_PID = [string]$PID",
      "$env:MIXDOG_ELEVATED_PARENT_TICKS = [string]([Diagnostics.Process]::GetCurrentProcess().StartTime.ToUniversalTime().Ticks)",
      "$variableNames = @('MIXDOG_ELEVATED_TOKEN','MIXDOG_ELEVATED_HOST_SCRIPT','MIXDOG_ELEVATED_HOST_SHA256','MIXDOG_ELEVATED_REQUEST','MIXDOG_ELEVATED_REQUEST_SHA256','MIXDOG_ELEVATED_RESPONSE','MIXDOG_ELEVATED_CANCEL','MIXDOG_ELEVATED_MARKER','MIXDOG_ELEVATED_PARENT_PID','MIXDOG_ELEVATED_PARENT_TICKS','MIXDOG_COMPUTER_INPUT_MARKER')",
      "$prelude = @($variableNames | ForEach-Object { '$env:' + $_ + ' = ' + (ConvertTo-MixdogLiteral ([string][Environment]::GetEnvironmentVariable($_))) }) -join [Environment]::NewLine",
      '$elevatedScript = $prelude + [Environment]::NewLine + $bootstrap',
      '$elevatedEncoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($elevatedScript))',
      "if ($elevatedEncoded.Length -gt 30000) { throw 'privileged_worker_unavailable: launch configuration exceeds Windows command line capacity' }",
      "$arguments = @('-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-EncodedCommand',$elevatedEncoded)",
      'try {',
      "  $process = Start-Process -FilePath $powershell -Verb RunAs -ArgumentList $arguments -Wait -PassThru",
      '  exit $process.ExitCode',
      '} catch {',
      "  [Console]::Error.WriteLine(('launcher_error:' + $_.Exception.Message))",
      '  exit 1223',
      '}',
    ].join('; ');
    let stopped = false;
    const cancel = () => writeFileSync(cancelPath, nonce, { mode: 0o600 });
    const job = elevatedJobs.begin(String(request.session_id || 'default'), cancel);
    elevatedSlots += 3;
    try {
      const launcherResult = await new Promise<{ code: number; stdout: string; stderr: string }>((resolve, reject) => {
        const child = spawnProcess('powershell.exe', [
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Bypass',
          '-Command',
          launcher,
        ], {
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
          env: {
            ...process.env,
            MIXDOG_ELEVATED_TOKEN: nonce,
            MIXDOG_COMPUTER_INPUT_MARKER: inputMarker,
            MIXDOG_ELEVATED_HOST_SCRIPT: hostScriptPath!,
            MIXDOG_ELEVATED_HOST_SHA256: sha256(hostBytes),
            MIXDOG_ELEVATED_REQUEST: requestPath,
            MIXDOG_ELEVATED_REQUEST_SHA256: sha256(requestBytes),
            MIXDOG_ELEVATED_RESPONSE: responsePath,
            MIXDOG_ELEVATED_CANCEL: cancelPath,
            MIXDOG_ELEVATED_MARKER: RESPONSE_MARKER,
          },
        });
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
          try { cancel(); } catch { /* parent death also cancels the input child */ }
          cleanupTimer = setTimeout(() => {
            try { child.kill(); } catch { /* launcher already exited */ }
            reject(new Error('privileged_worker_cleanup_unconfirmed: elevated input did not acknowledge cancellation'));
          }, 6_000);
        }, 120_000);
        child.once('error', (error) => {
          clearTimeout(timer);
          if (cleanupTimer) clearTimeout(cleanupTimer);
          if (!child.pid) stopped = true;
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
      let envelope = '';
      try {
        envelope = readFileSync(responsePath, 'utf8');
      } catch {
        const launcherDetail = `${launcherResult.stderr}\n${launcherResult.stdout}`
          .trim()
          .replace(/\s+/g, ' ')
          .slice(0, 1000);
        if (launcherResult.code === 1223) {
          stopped = true;
          throw new Error('privileged_worker_cancelled: UAC consent was declined');
        }
        if (launcherResult.code === 0) {
          throw new Error('privileged_worker_unavailable: elevated worker returned no response');
        }
        throw new Error(
          `privileged_worker_launcher_failed: elevated worker exited with code ${launcherResult.code}`
          + (launcherDetail ? ` (${launcherDetail})` : ''),
        );
      }
      const newline = envelope.indexOf('\n');
      const responseToken = (newline >= 0 ? envelope.slice(0, newline) : envelope)
        .replace(/^\uFEFF/, '')
        .replace(/\r$/, '');
      const receipt = newline >= 0 ? envelope.slice(newline + 1).trim().split(/\r?\n/) : [];
      const responseLine = receipt.slice(1).join('\n');
      if (responseToken !== nonce) {
        throw new Error('privileged_worker_rejected: response authentication failed');
      }
      if (receipt[0] !== 'STOPPED') {
        throw new Error('privileged_worker_cleanup_unconfirmed: elevated worker did not confirm termination');
      }
      stopped = true;
      if (responseLine.startsWith('ERROR:')) {
        throw new Error(`privileged_worker_failed: ${responseLine.slice(6)}`);
      }
      const marker = responseLine.indexOf(RESPONSE_MARKER);
      if (marker < 0) throw new Error('privileged_worker_failed: structured response is missing');
      const parsed = JSON.parse(responseLine.slice(marker + RESPONSE_MARKER.length)) as PowerShellResponse;
      if (parsed.id !== id) throw new Error('privileged_worker_rejected: response id mismatch');
      return parsed;
    } finally {
      job.finish(stopped);
      if (stopped) elevatedSlots -= 3;
      try { unlinkSync(requestPath); } catch { /* already removed */ }
      try { unlinkSync(responsePath); } catch { /* no response on UAC cancellation */ }
      if (stopped) {
        try { unlinkSync(cancelPath); } catch { /* no cancellation requested */ }
      }
    }
  }

  /** Hand the warm-up worker to the spare slot instead of reaping it: it has
   *  already paid startup, and the next session would otherwise pay it again. */
  function adoptWarmedWorker(sessionId: string): void {
    const warmed = powerShellBySession.get(sessionId);
    if (warmed && !warmed.killed) {
      const duplicateSpare = spareHostWorker;
      spareHostWorker = null;
      if (duplicateSpare && duplicateSpare !== warmed && !duplicateSpare.killed) {
        try { duplicateSpare.kill(); } catch { /* already gone */ }
      }
      powerShellBySession.delete(sessionId);
      workerLastUsedAt.delete(sessionId);
      spareHostWorker = warmed;
      return;
    }
    ensureSpareHostWorker();
  }

  /** The published script is a temp artifact; it goes when the host does. */
  function removeHostScript(): void {
    if (hostScriptPath) {
      try { unlinkSync(hostScriptPath); } catch { /* already gone */ }
    }
    hostScriptPath = null;
  }

  /** An idle spare has no reason to outlive the bridge that would use it. */
  function releaseSpareWorker(): void {
    if (spareHostWorker && !spareHostWorker.killed) {
      try { spareHostWorker.kill(); } catch { /* already gone */ }
    }
    spareHostWorker = null;
  }

  function residentWorkerPids(): number[] {
    return [...hostWorkers]
      .filter((child) => child.exitCode === null && child.signalCode === null)
      .map((child) => Number(child.pid))
      .filter((pid) => Number.isInteger(pid) && pid > 0);
  }

  return {
    powerShellBySession,
    workerLastUsedAt,
    adoptWarmedWorker,
    releaseSpareWorker,
    residentWorkerPids,
    removeHostScript,
    ensureHostScript,
    ensureSpareHostWorker,
    ensurePowerShell,
    retirePowerShell,
    callPowerShell,
    callPowerShellElevated,
    cancelElevatedSession: elevatedJobs.cancel,
    elevatedSessionIds: elevatedJobs.sessionIds,
  };
}
