/**
 * The one-shot elevated path: the launcher that raises a UAC-consented worker,
 * the run-to-completion watchdog around it, and the authentication of the
 * response file it leaves behind. Worker-pool bookkeeping (slots, sessions)
 * stays with the pool, which hands in `begin` to open the job.
 */
import type { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { elevatedProgramInvocation } from './elevated-program';
import { RESPONSE_MARKER } from './program';
import type { PowerShellResponse } from '../shared/types';

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
    "$variableNames = @('MIXDOG_ELEVATED_TOKEN','MIXDOG_ELEVATED_HOST_SCRIPT','MIXDOG_ELEVATED_HOST_SHA256','MIXDOG_ELEVATED_REQUEST','MIXDOG_ELEVATED_REQUEST_SHA256','MIXDOG_ELEVATED_RESPONSE','MIXDOG_ELEVATED_CANCEL','MIXDOG_ELEVATED_MARKER','MIXDOG_ELEVATED_PARENT_PID','MIXDOG_ELEVATED_PARENT_TICKS','MIXDOG_COMPUTER_INPUT_MARKER','MIXDOG_COMPUTER_INACTIVE_LEDGER')",
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

const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');

/** One elevated round trip: stages the request beside the host script, runs
 *  the launcher, authenticates the reply and removes its files. `begin` opens
 *  the pool's job for this run and returns the finisher; `finish(true)` is
 *  called once the worker is known to have stopped. */
export async function runElevatedRequest(options: {
  request: Record<string, unknown>;
  id: number;
  directory: string;
  hostScriptPath: string;
  inputMarker: string;
  inactiveLedger: string;
  spawnProcess: typeof spawn;
  begin: (cancel: () => void) => { finish(stopped: boolean): void };
}): Promise<PowerShellResponse> {
  const { directory, hostScriptPath, id } = options;
  const nonce = randomBytes(24).toString('base64url');
  const requestPath = join(directory, `computer-elevated-${nonce}.request.json`);
  const responsePath = join(directory, `computer-elevated-${nonce}.response.txt`);
  const cancelPath = join(directory, `computer-elevated-${nonce}.cancel`);
  const requestBytes = Buffer.from(`${JSON.stringify({ ...options.request, id })}\n`, 'utf8');
  const hostBytes = readFileSync(hostScriptPath);
  writeFileSync(requestPath, requestBytes, {
    encoding: 'utf8',
    mode: 0o600,
  });
  const launcher = elevatedLauncherCommand();
  let stopped = false;
  const cancel = () => writeFileSync(cancelPath, nonce, { mode: 0o600 });
  const job = options.begin(cancel);
  try {
    const launcherResult = await runElevatedLauncher({
      spawnProcess: options.spawnProcess,
      launcher,
      env: {
        ...process.env,
        MIXDOG_ELEVATED_TOKEN: nonce,
        MIXDOG_COMPUTER_INPUT_MARKER: options.inputMarker,
        MIXDOG_COMPUTER_INACTIVE_LEDGER: options.inactiveLedger,
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
