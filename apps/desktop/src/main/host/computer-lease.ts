/**
 * `host/computer/foregroundLease`: a Computer Use helper's request for the foreground lock, relayed by the core
 * (`computer/backend/foreground-lock-host.ts` `handle`). Windows grants the lock only to a process that may set the
 * foreground, which this one is while the user works in a Mixdog window, so this process owns the lease: the lease
 * owner (`createHostForegroundLock`, on its own thread) serves the helpers the core runs, with no PowerShell worker
 * in between. The owner writes its answer as the reply line a worker would read on its stdin; the core writes that
 * line to the helper, so here it becomes the request's result.
 */
import type {
  HostComputerForegroundLeaseParams,
  HostComputerForegroundLeaseResult,
} from '../../../../../packages/protocol/src/index.ts';
import {
  createHostForegroundLock,
  FOREGROUND_LOCK_REPLY_PREFIX,
  type ForegroundLeaseRuntime,
  type HostForegroundLock,
  nextLeaseInstance,
  processForegroundLock,
} from '../computer/backend/foreground-lock-host';
import { HOST_COMMAND_FAILED, HOST_INVALID_PARAMS, HostRpcError, type HostConnection, objectParams } from './connection';

export const HOST_COMPUTER_FOREGROUND_LEASE = 'host/computer/foregroundLease';

/** The longest an ask waits for the owner's line: a little past the helper's own wait (lease.rs ANSWER_TIMEOUT_MS,
 *  250 ms), after which nobody reads the answer and a stalled ask would only hold the next one. */
const ANSWER_WAIT_MS = 400;
const MAX_ID = 2 ** 31 - 1;

const unavailable = (reason: string): HostComputerForegroundLeaseResult => ({
  kind: 'unavailable',
  answer: 'unavailable',
  reason,
});

/** The result a reply line stands for (`foreground-lock-host.ts` `answer` and `released`), when it answers the ask
 *  `op` (action, seq): a late line of an earlier ask that timed out is not this ask's answer. */
function resultOf(
  line: string,
  op: 'acquire' | 'release',
  action: number,
  seq: number
): HostComputerForegroundLeaseResult | undefined {
  const [kind, said_action, said_seq, lease, said, deadline] = line
    .slice(FOREGROUND_LOCK_REPLY_PREFIX.length)
    .trim()
    .split(' ');
  if (Number(said_action) !== action || Number(said_seq) !== seq) return undefined;
  if (kind === 'ack' && op === 'acquire') return { kind, answer: said, lease: Number(lease), deadlineAt: Number(deadline) };
  if (kind === 'released' && op === 'release') return { kind, lease: Number(lease), outcome: said };
  return undefined;
}

const id = (value: unknown, min: number): boolean =>
  Number.isSafeInteger(value) && (value as number) >= min && (value as number) <= MAX_ID;

/**
 * Serves `host/computer/foregroundLease`. Without `runtime` the process's one lease owner serves the asks (on Windows;
 * other platforms have no lock to lease and answer `unavailable`); a test passes its own runtime, which gets an owner of
 * its own that the connection's close ends.
 */
export function registerComputerLease(
  connection: HostConnection,
  runtime?: ForegroundLeaseRuntime | null
): void {
  const own = runtime !== undefined;
  let ownLock: HostForegroundLock | undefined;
  const lockOf = (): HostForegroundLock | undefined => {
    if (own) return runtime ? (ownLock ??= createHostForegroundLock(runtime)) : undefined;
    return process.platform === 'win32' ? processForegroundLock() : undefined;
  };
  // The core's helper ids are strings; the owner numbers its workers, never reusing one.
  const instances = new Map<string, number>();
  connection.onClose(() => {
    // Every reconnect closes the connection: the helpers it relayed for are gone, and an owner of this connection's own is
    // ended (a later ask starts a new one). The process's owner outlives the connection.
    const lock = own ? ownLock : processLockIfStarted(instances);
    for (const instance of instances.values()) lock?.workerGone(instance);
    instances.clear();
    if (own) {
      const closing = ownLock;
      ownLock = undefined;
      void closing?.dispose();
    }
  });
  connection.handleRequest(HOST_COMPUTER_FOREGROUND_LEASE, async (params): Promise<HostComputerForegroundLeaseResult> => {
    const ask = objectParams<HostComputerForegroundLeaseParams>(params, HOST_COMPUTER_FOREGROUND_LEASE);
    const { instance: helper, op, action } = ask;
    if (typeof helper !== 'string' || (op !== 'acquire' && op !== 'release' && op !== 'gone')) {
      throw new HostRpcError(HOST_INVALID_PARAMS, `${HOST_COMPUTER_FOREGROUND_LEASE} needs op, instance and action.`);
    }
    if (op !== 'gone') {
      const numbers =
        id(action, 1) &&
        id(ask.seq, 1) &&
        (op === 'release'
          ? id(ask.lease, 0)
          : Number.isSafeInteger(ask.holdMs) && typeof ask.answerBy === 'number' && Number.isFinite(ask.answerBy));
      if (!numbers) {
        throw new HostRpcError(
          HOST_INVALID_PARAMS,
          `${HOST_COMPUTER_FOREGROUND_LEASE} needs integer action, seq and ${op === 'release' ? 'lease' : 'holdMs, and a finite answerBy'}.`
        );
      }
    } else if (typeof action !== 'number') {
      throw new HostRpcError(HOST_INVALID_PARAMS, `${HOST_COMPUTER_FOREGROUND_LEASE} needs op, instance and action.`);
    }
    const lock = lockOf();
    if (!lock) return unavailable('no foreground lock on this platform');
    let instance = instances.get(helper);
    if (op === 'gone') {
      if (instance !== undefined) lock.workerGone(instance);
      instances.delete(helper);
      return unavailable('gone');
    }
    if (instance === undefined) instances.set(helper, (instance = nextLeaseInstance()));
    const number = instance;
    const result = await new Promise<HostComputerForegroundLeaseResult | undefined>((resolve) => {
      const timer = setTimeout(resolve, ANSWER_WAIT_MS, undefined);
      lock.handle(
        JSON.stringify({
          op,
          action,
          seq: ask.seq,
          hold_ms: ask.holdMs,
          answer_by: ask.answerBy,
          lease: ask.lease,
        }),
        {
          instance: number,
          pid: undefined,
          // The core relays only the actions its helper has in flight.
          owns: () => true,
          write: (reply) => {
            const answered = resultOf(reply, op, action as number, ask.seq as number);
            if (!answered) return;
            clearTimeout(timer);
            resolve(answered);
          },
        }
      );
    });
    if (!result) {
      // A release nobody answered may leave a lease held: the core records it as unknown, never as nothing held.
      if (op === 'release') throw new HostRpcError(HOST_COMMAND_FAILED, 'the lease owner did not answer the release');
      return unavailable('the lease owner did not answer');
    }
    // The action's facts go back once it is over: with its release (after the release has updated them), or with an
    // acquire that leased nothing. The core keeps the last per action and joins them to the helper's reply.
    const done = op === 'release' || (result.kind === 'ack' && !result.lease);
    const facts = done ? lock.takeFacts(number, action as number) : undefined;
    return facts ? { ...result, facts: facts as HostComputerForegroundLeaseResult['facts'] } : result;
  });
}

/** The process owner's instances end with the connection that numbered them; nothing is started for that. */
function processLockIfStarted(instances: Map<string, number>): HostForegroundLock | undefined {
  return instances.size > 0 && process.platform === 'win32' ? processForegroundLock() : undefined;
}
