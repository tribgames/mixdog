// Spawn phase of one foreground shell run: argv shaping, the warm pwsh
// standby fast path, the spawn-burst gate around process creation, and the
// delayed live foreground record once the command has reached a shell.
import { acquire as acquireChildSpawnSlot } from '../../../../shared/child-spawn-gate.mjs';
import { publishForegroundShellRecord, trackForegroundShellJob } from '../builtin/shell-jobs.mjs';
import { nativeSpawnFileCaptureReady, setNativeTaskStartedAt } from './native-spawn-client.mjs';
import { _maybeEncodePowerShellCommand } from '../shell-powershell.mjs';
import { spawnShellWithRetry as _spawnShellWithRetry } from './shell-spawn-retry.mjs';
import { takeWarmShellStandby } from './shell-warm-standby.mjs';
import { SHELL_OUTPUT_DISK_CAP } from '../shell-exec-output.mjs';

// Foreground visibility threshold. Every shell readout (CLI statusline,
// desktop island) scans the on-disk job records, so a foreground command is
// invisible without one. Commands that settle inside this window can never
// survive long enough for a 1 s status refresh to show them, so publishing
// their record would only cost two file writes per command.
// MIXDOG_SHELL_FOREGROUND_RECORD_MS overrides; 0 publishes every command.
const _envForegroundRecord = Math.floor(Number(process.env.MIXDOG_SHELL_FOREGROUND_RECORD_MS));
const FOREGROUND_RECORD_DELAY_MS =
  Number.isFinite(_envForegroundRecord) && _envForegroundRecord >= 0 ? _envForegroundRecord : 300;

function shapeArgv({ directArgv, shellArg, shellArgs, command, execScript }) {
  const useDirectArgv = Array.isArray(directArgv);
  // Direct-exe spawns already bypass the shell, so they keep using the
  // command verbatim; only the shell-parsed form honours execScript.
  const shellScript = !useDirectArgv && typeof execScript === 'string' && execScript ? execScript : command;
  const spawnCommand = useDirectArgv ? String(command ?? '') : _maybeEncodePowerShellCommand(shellScript);
  let argv;
  if (useDirectArgv) argv = [...directArgv];
  else if (Array.isArray(shellArgs) && shellArgs.length > 0) argv = [...shellArgs, spawnCommand];
  else argv = [shellArg, spawnCommand];
  return { useDirectArgv, spawnCommand, argv };
}

// Warm-standby fast path (pwsh only): a pre-spawned bootstrap pwsh reads the
// script from stdin, skipping CreateProcess + Defender scan for this call.
// Any miss (env drift, TTL, dead/warming standby, MIXDOG_SHELL_WARM_STANDBY=0)
// falls through to the gated spawn.
async function takeStandby({ run, useDirectArgv, shell, shellArg, env, cwd, command, ownerSessionId, clientHostPid }) {
  if (useDirectArgv || shellArg !== '-Command') return null;
  let standby = null;
  try {
    standby = takeWarmShellStandby({ shell, env, cwd });
  } catch {
    standby = null;
  }
  if (!standby) return null;
  let tracked = null;
  try {
    tracked = await trackForegroundShellJob({
      command,
      cwd,
      child: standby.spawned.child,
      jobId: run.foregroundRecordId,
      ownerSessionId,
      clientHostPid,
    });
  } catch {}
  if (tracked) return standby;
  // The parked process settled or lost its native request identity.
  // Do not feed it; replace it with a normally tracked spawn.
  try {
    standby.spawned.child.kill();
  } catch {}
  return null;
}

// Spawn-burst gate: hold a 'process-spawn' slot only across process creation
// (CreateProcess + AV scan + EPERM retries), released the moment the child
// exists. Bounds the Defender convoy a shell burst creates without limiting
// how many commands RUN concurrently — the full command lifetime is
// intentionally NOT gated: bash/pwsh commands can run for minutes and would
// starve rg/code_graph.
async function gatedSpawn({
  run,
  argv,
  shell,
  shellArg,
  env,
  cwd,
  abortSignal,
  command,
  ownerSessionId,
  clientHostPid,
}) {
  const releaseSpawnSlot = await acquireChildSpawnSlot(abortSignal || null, 'process-spawn', {
    ownerKey: ownerSessionId,
  });
  // Gate drain can grant several waiters in one tick. Yield so CreateProcess
  // + AV does not freeze graph/patch/search callbacks in that same turn.
  await new Promise((resolve) => setImmediate(resolve));
  if (abortSignal?.aborted) {
    try {
      releaseSpawnSlot();
    } catch {
      /* idempotent */
    }
    throw abortSignal.reason || new Error('aborted');
  }
  // CC parity (ShellCommand.ts): give the child its OWN fds on the capture
  // files so its output never depends on a reader living in this process. A
  // job the caller deliberately leaves running — a task's server — then
  // keeps writing after we exit; on a pipe it dies on its next write the
  // moment our reader is gone.
  const { taskOutput } = run;
  const capture = nativeSpawnFileCaptureReady() ? taskOutput.openDirectCapture() : null;
  try {
    return await _spawnShellWithRetry({
      shell,
      argv,
      shellArg,
      cwd,
      spawnOptions: {
        env,
        cwd,
        outputLimit: SHELL_OUTPUT_DISK_CAP,
        rawOutput: true,
        jobId: run.foregroundRecordId,
        command,
        ownerSessionId,
        clientHostPid,
        ...(capture
          ? {
              stdoutPath: taskOutput.stdoutPath,
              stderrPath: taskOutput.stderrPath,
            }
          : {}),
        // POSIX: detached gives the child its own process group so treeKill can
        // signal the whole group. Windows detached has different console
        // semantics, so it stays off there.
      },
    });
  } finally {
    try {
      releaseSpawnSlot();
    } catch {
      /* idempotent */
    }
  }
}

/**
 * Spawn the command's shell (or reuse a warm standby) and stamp the run with
 * the moment the command reached it. Throws on spawn failure; the caller
 * turns that into the spawn-failed result.
 */
export async function spawnShellChild({
  run,
  shell,
  shellArg,
  shellArgs,
  command,
  env,
  cwd,
  abortSignal,
  directArgv,
  execScript,
  ownerSessionId,
  clientHostPid,
}) {
  const { useDirectArgv, spawnCommand, argv } = shapeArgv({ directArgv, shellArg, shellArgs, command, execScript });
  const onChildError = (err) => {
    run.spawnError = run.spawnError || err;
    run.failurePhase = 'tool';
    run.failureReason = 'spawn failed';
    if (run.settle) run.settle(1, null);
    else run.pendingChildError = run.pendingChildError || err;
  };
  const standby = await takeStandby({
    run,
    useDirectArgv,
    shell,
    shellArg,
    env,
    cwd,
    command,
    ownerSessionId,
    clientHostPid,
  });
  const spawned =
    standby?.spawned ??
    (await gatedSpawn({ run, argv, shell, shellArg, env, cwd, abortSignal, command, ownerSessionId, clientHostPid }));
  run.child = spawned.child;
  spawned.attachErrorHandler(onChildError);
  // Feed the standby only after the error handler is attached; server
  // messages cannot be processed before this synchronous block yields.
  if (standby) standby.feed(spawnCommand, cwd);
  // The command has now reached a shell. This is the start moment every
  // readout measures from, and the point from which a still-running
  // command deserves to be visible in the shell readouts.
  run.commandStartedAtMs = Date.now();
  setNativeTaskStartedAt(run.foregroundRecordId, run.commandStartedAtMs);
  run.foregroundRecordTimer = setTimeout(() => {
    run.foregroundRecordTimer = null;
    if (run.settled || run.autoBackgrounded || !run.child?.pid) return;
    run.foregroundRecordPublished = true;
    publishForegroundShellRecord({
      jobId: run.foregroundRecordId,
      command,
      cwd,
      pid: run.child.pid,
      startedAtMs: run.commandStartedAtMs,
      ownerSessionId,
      clientHostPid,
    });
  }, FOREGROUND_RECORD_DELAY_MS);
  run.foregroundRecordTimer.unref?.();
}
