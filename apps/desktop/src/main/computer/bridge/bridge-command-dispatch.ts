/** Where one accepted bridge command goes: the core's `computer/bridge/run`, which answers the runtime-only actions
 *  (secret binding and typing, turn settlement, session abort), the secret-focus capture hold, the allowance of
 *  concurrent requests and the serialisation of a session's commands. A dropped caller ends its call there with
 *  `computer/bridge/abort`. */
import type {
  ComputerBridgeAbortParams,
  ComputerBridgeRunParams,
  ComputerBridgeRunResult,
} from '../../../../../../packages/protocol/src/index.ts';
import type { BridgeCommand } from './request-policy';
import type { CallCore } from './bridge-server-contract';

export const COMPUTER_BRIDGE_RUN = 'computer/bridge/run';
export const COMPUTER_BRIDGE_ABORT = 'computer/bridge/abort';

/** The session a command runs in (`default` when it names none). */
export function sessionKeyOf(command: BridgeCommand): string {
  return String(command.session_id || '') || 'default';
}

let nextSignal = 0;

/** Runs one accepted command in the core. `signal` aborting (the caller's connection dropped) ends the call there, as a
 *  dropped HTTP caller always ended its session's work. Rejects with why the core could not take it. */
export async function runOnCore(
  callCore: CallCore,
  command: BridgeCommand,
  signal: AbortSignal
): Promise<ComputerBridgeRunResult> {
  const sessionKey = sessionKeyOf(command);
  const signalId = `bridge-${++nextSignal}`;
  const params: ComputerBridgeRunParams = { command: command as ComputerBridgeRunParams['command'], sessionKey, signalId };
  const abort = (): void => {
    const ending: ComputerBridgeAbortParams = { sessionKey, signalId };
    void callCore(COMPUTER_BRIDGE_ABORT, ending).catch(() => {
      /* the core is gone or the call already ended */
    });
  };
  signal.addEventListener('abort', abort, { once: true });
  try {
    const running = callCore(COMPUTER_BRIDGE_RUN, params);
    // The abort is sent once the run is on the wire, so the core has the call to end.
    if (signal.aborted) abort();
    return (await running) as ComputerBridgeRunResult;
  } finally {
    signal.removeEventListener('abort', abort);
  }
}

/** Ends every queued and running command of one session (the stop of a bridge). */
export function abortSessionOnCore(callCore: CallCore, sessionKey: string): Promise<unknown> {
  const params: ComputerBridgeAbortParams = { sessionKey };
  return callCore(COMPUTER_BRIDGE_ABORT, params);
}
