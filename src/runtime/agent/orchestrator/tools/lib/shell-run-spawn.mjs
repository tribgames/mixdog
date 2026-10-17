// Spawn phase of one foreground shell run: argv shaping, the warm pwsh
// standby fast path, the spawn-burst gate around process creation, and the
// delayed live foreground record once the command has reached a shell.
import { acquire as acquireChildSpawnSlot } from '../../../../shared/child-spawn-gate.mjs';
import {
  killShellJob,
  publishForegroundShellRecord,
  trackForegroundShellJob,
  waitForShellJob,
} from '../builtin/shell-jobs.mjs';
import {
  nativeSpawnFileCaptureReady,
  nativeSpawnSupportsStdinPipe,
  setNativeTaskStartedAt,
  warmNativeSpawnServer,
} from './native-spawn-client.mjs';
import { _maybeEncodePowerShellCommand } from '../shell-powershell.mjs';
import { spawnShellWithRetry as _spawnShellWithRetry } from './shell-spawn-retry.mjs';
import { STANDBY_ARGS, takeWarmShellStandby } from './shell-warm-standby.mjs';
import { SHELL_OUTPUT_DISK_CAP } from '../shell-exec-output.mjs';
import { admitWorkspaceActivity, tryAdmitWorkspaceActivity } from '../../../../shared/worktrees/activity-gate.mjs';
import { worktreeError } from '../../../../shared/worktrees/contract.mjs';
import { capturePreKill, registerForegroundOwnedTree, treeKillForceSettle } from './shell-run-state.mjs';
import { releaseAdmissionOnConfirmedTermination } from './shell-run-settle.mjs';
import { killAfterSnapshot } from './shell-descendants.mjs';

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
    standby = takeWarmShellStandby({ shell, env });
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
  stdinPipe,
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
        ...(stdinPipe ? { stdinPipe: true } : {}),
        ...(capture
          ? {
              stdoutPath: taskOutput.stdoutPath,
              stderrPath: taskOutput.stderrPath,
            }
          : {}),
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
async function spawnAdmittedShellChild({
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
  // Set before any child exists: a startup that fails after the child is
  // created still publishes a visible record and an owned termination hold.
  run.foregroundRecordInput = { command, cwd, ownerSessionId, clientHostPid };
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
  // Standby miss on pwsh: spawn a fresh pwsh with the standby bootstrap and
  // feed the script through stdin, so a parse error is still reported in
  // UTF-8 and both paths run the script identically. Spawn servers without
  // stdin-pipe support keep the -Command argv delivery.
  const stdinScript =
    !standby &&
    !useDirectArgv &&
    shellArg === '-Command' &&
    (await warmNativeSpawnServer()) &&
    nativeSpawnSupportsStdinPipe()
      ? spawnCommand
      : null;
  const spawned =
    standby?.spawned ??
    (await gatedSpawn({
      run,
      argv: stdinScript === null ? argv : STANDBY_ARGS,
      stdinPipe: stdinScript !== null,
      shell,
      shellArg,
      env,
      cwd,
      abortSignal,
      command,
      ownerSessionId,
      clientHostPid,
    }));
  run.child = spawned.child;
  registerForegroundOwnedTree(run, ownerSessionId);
  const parentAdmission = run.workspaceAdmission;
  const childAdmission = tryAdmitWorkspaceActivity(ownerSessionId || run.foregroundRecordId, cwd || process.cwd(), {
    pid: Number(run.child.pid) || process.pid,
    kind: 'command',
  });
  if (!childAdmission) throw worktreeError('WORKTREE_BUSY_JOBS', 'The command workspace changed during spawn.');
  run.workspaceAdmission = () => {
    childAdmission();
    parentAdmission();
  };
  spawned.attachErrorHandler(onChildError);
  // Feed the script only after the error handler is attached; server
  // messages cannot be processed before this synchronous block yields.
  // Single atomic write+EOF, as for the standby.
  abortSignal?.throwIfAborted();
  if (standby) standby.feed(spawnCommand, cwd);
  else if (stdinScript !== null) spawned.child.writeStdin(stdinScript, { close: true });
  // The command has now reached a shell. This is the start moment every
  // readout measures from, and the point from which a still-running
  // command deserves to be visible in the shell readouts.
  run.commandStartedAtMs = Date.now();
  setNativeTaskStartedAt(run.foregroundRecordId, run.commandStartedAtMs);
  run.foregroundRecordTimer = setTimeout(() => {
    run.foregroundRecordTimer = null;
    if (run.settled || run.autoBackgrounded || !run.child?.pid) return;
    run.foregroundRecordPublished = true;
    try {
      publishForegroundShellRecord({
        ...run.foregroundRecordInput,
        jobId: run.foregroundRecordId,
        pid: run.child.pid,
        startedAtMs: run.commandStartedAtMs,
      });
    } catch (error) {
      run.spawnError = error;
      run.failureReason = 'workspace publication failed';
      treeKillForceSettle(run, 'workspace-publication-failed');
    }
  }, FOREGROUND_RECORD_DELAY_MS);
  run.foregroundRecordTimer.unref?.();
}

/** Admission precedes both native process creation and feeding a warm shell. */
export async function spawnShellChild(input) {
  input.run.workspaceAdmission = await admitWorkspaceActivity(
    input.ownerSessionId || input.run.foregroundRecordId,
    input.cwd || process.cwd(),
    input.abortSignal,
    { kind: 'command' }
  );
  try {
    input.abortSignal?.throwIfAborted();
    return await spawnAdmittedShellChild(input);
  } catch (error) {
    if (!input.run.child) {
      input.run.workspaceAdmission();
      input.run.workspaceAdmission = null;
    } else {
      try {
        // Identities first: the kill may break the parent chain.
        // Bounded: the kill is sent even if the snapshot hangs or fails.
        await killAfterSnapshot(capturePreKill(input.run), () => killShellJob(input.run.foregroundRecordId));
        const detail = await waitForShellJob(input.run.foregroundRecordId);
        if (!detail || !['completed', 'failed', 'cancelled'].includes(detail.nativeStatus)) {
          throw new Error('The child termination could not be confirmed; workspace admission is retained.');
        }
        input.run.workspaceAdmission?.();
        input.run.workspaceAdmission = null;
      } catch (cleanupError) {
        input.run.killUnconfirmed = true;
        // No settle will ever run for this run; the reservation is released
        // only once the child has exited and its descendants are gone.
        releaseAdmissionOnConfirmedTermination(input.run);
        throw new AggregateError([error, cleanupError], 'Shell startup failed and workspace cleanup remains blocked.');
      }
    }
    throw error;
  }
}
