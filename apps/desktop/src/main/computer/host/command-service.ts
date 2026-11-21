/** The host's in-process command service: what the core's `host/computer/command` runs. One allowance of concurrent
 *  commands, a command's answer sealed against secrets, a dropped caller ending its session, and idle workers reclaimed
 *  while Computer Use is on. The loopback HTTP bridge (and `computer-bridge.json`) is `computer/bridge/`. */
import { secretInputs } from '../../secret-input';
import { computerUseCoordinator } from '../session/coordinator';
import { CHROME_SETUP_SESSION_ID } from '../shared/common';
import type { ComputerCommand, ComputerCommandResult } from '../shared/types';
import { isComputerLifecycleControl } from './action-sets';
import { dispatchBridgeCommand } from './bridge-command-dispatch';
import type { BridgeServerHost } from './bridge-server-contract';
import type { CommandEndpoint } from './command-fence';
import {
  MAX_COMPUTER_RESPONSE_BYTES,
  validateComputerReply,
} from '../../../shared/core-src/runtime/computer-bridge/limits.mjs';

/** How often idle session workers are reclaimed while the service runs. */
const REAP_INTERVAL_MS = 60_000;

/** What a command answers: the sealed reply value, or the redacted message of why it failed. */
export type BridgeAnswer = { ok: true; value: ComputerCommandResult } | { ok: false; error: string };

/** What a command past the allowance is refused with. */
export const CAPACITY_REFUSAL = 'computer_capacity_exhausted: too many active requests';

/** Concurrent commands admitted: lifecycle controls past the ordinary limit. */
function requestCapacity(command: ComputerCommand): number {
  return isComputerLifecycleControl(command) ? 40 : 32;
}

/** A saved-login fill counts as running from the moment it is accepted,
 *  before any queueing or target preparation, so its turn's settlement waits
 *  for it; one of a settled turn or an absent owner is refused here (the
 *  reason). Any other command is not a fill (null). */
function admitSavedLoginFill(command: ComputerCommand): string | (() => void) | null {
  if (command.action !== 'fill_saved_login') return null;
  return secretInputs.admitSavedLoginFill({
    sessionId: String(command.session_id || ''),
    turnId: Number(command.turn_id),
    ownerId: typeof command.runtime_id === 'string' ? command.runtime_id : '',
  });
}

/** Prepare a reply to leave the host, or throw why it cannot. */
function sealReply(command: ComputerCommand, value: ComputerCommandResult): void {
  // A secret typed in this session never comes back in a reply.
  if (typeof value?.text === 'string') value.text = secretInputs.redact(String(command.session_id || ''), value.text);
  // Nor do the pixels of a field a saved login was typed into, whatever
  // recovery observation a failed fill came back with.
  if (command.action === 'fill_saved_login') delete value.image;
  validateComputerReply(value);
  if (Buffer.byteLength(JSON.stringify(value)) > MAX_COMPUTER_RESPONSE_BYTES) {
    throw new Error('computer response exceeds byte limit; input may have executed and was not replayed');
  }
}

async function answerPublicCommand(
  host: Parameters<typeof dispatchBridgeCommand>[0],
  command: ComputerCommand,
  endpoint: CommandEndpoint
): Promise<BridgeAnswer> {
  try {
    const value = await dispatchBridgeCommand(host, command, endpoint);
    sealReply(command, value);
    return { ok: true, value };
  } catch (error) {
    // Errors are model-bound too: a remembered secret never comes back in one.
    const message = (error as Error).message || String(error);
    return { ok: false, error: secretInputs.redact(String(command.session_id || ''), message) };
  }
}

export type CommandServiceHost = Pick<
  BridgeServerHost,
  | 'powerShellBySession'
  | 'elevatedSessionIds'
  | 'abortComputerSession'
  | 'executeSerialized'
  | 'reapIdleSessionWorkers'
  | 'waitForCleanup'
  | 'waitForUser'
>;

export function createCommandService(host: CommandServiceHost) {
  let activeRequests = 0;
  let reaper: NodeJS.Timeout | null = null;

  /** One command under the allowance, admitted through `endpoint`: null when the allowance is spent; otherwise the
   *  answer. The endpoint's aborted signal ends the session's queued and running work the way a dropped caller does. */
  async function answerAdmittedCommand(
    command: ComputerCommand,
    endpoint: CommandEndpoint
  ): Promise<BridgeAnswer | null> {
    const { signal } = endpoint;
    if (activeRequests >= requestCapacity(command)) return null;
    const finishFill = admitSavedLoginFill(command);
    if (typeof finishFill === 'string') {
      return { ok: false, error: `saved_login_unavailable: ${finishFill}; no input was sent` };
    }
    activeRequests++;
    // The periodic reclaim alone is too late: a burst of short sessions can
    // exhaust the worker limit between two runs, and the caller owns none
    // of those sessions. Reclaim on the request path as well.
    host.reapIdleSessionWorkers();
    const abortSession = (): void => {
      if (command.action === 'wait_for_user' || isComputerLifecycleControl(command)) return;
      void host.abortComputerSession(command).catch(() => {
        /* host already idle */
      });
    };
    if (signal.aborted) abortSession();
    else signal.addEventListener('abort', abortSession, { once: true });
    try {
      return await answerPublicCommand(host, command, endpoint);
    } finally {
      activeRequests--;
      signal.removeEventListener('abort', abortSession);
      finishFill?.();
    }
  }

  /** Every live session is aborted; the coordinator resets only once the
   *  aborts settled and input cleanup is confirmed. */
  async function releaseSessions(): Promise<void> {
    const stopped = await Promise.allSettled(
      [...new Set([...host.powerShellBySession.keys(), ...host.elevatedSessionIds()])]
        .filter((sessionId) => sessionId !== CHROME_SETUP_SESSION_ID)
        .map((sessionId) => host.abortComputerSession({ action: 'session_abort', session_id: sessionId }))
    );
    const cleanupConfirmed = (await host.waitForCleanup?.()) ?? true;
    if (cleanupConfirmed && stopped.every((result) => result.status === 'fulfilled')) computerUseCoordinator.reset();
    else computerUseCoordinator.pauseForUser('input_cleanup_unconfirmed');
  }

  function start(): void {
    if (reaper) return;
    reaper = setInterval(() => host.reapIdleSessionWorkers(), REAP_INTERVAL_MS);
    reaper.unref?.();
  }

  /** Overlapping stops share one cleanup. */
  let stopping: Promise<void> | null = null;

  async function stop(): Promise<void> {
    if (reaper) clearInterval(reaper);
    reaper = null;
    if (stopping) return await stopping;
    stopping = releaseSessions();
    try {
      await stopping;
    } finally {
      stopping = null;
    }
  }

  /** The host protocol's command and capture: the command's allowance, refusal and abort handling, every worker request
   *  admitted through `endpoint`. */
  async function answerCommand(command: ComputerCommand, endpoint: CommandEndpoint): Promise<BridgeAnswer> {
    return (await answerAdmittedCommand(command, endpoint)) ?? { ok: false, error: CAPACITY_REFUSAL };
  }

  return { start, stop, answerCommand };
}
