// The decisions of a connect: what the pre-check allows, which saved record a
// first-time target gets, and the progress the window and the log see.
import { randomUUID } from 'node:crypto';
import type { IpcMainInvokeEvent, WebContents } from 'electron';

import { DESKTOP_IPC } from '../../shared/contract-ipc';
import type {
  DesktopSshConnectRequest,
  DesktopSshConnectResult,
  DesktopSshHost,
  DesktopSshInspection,
  DesktopSshProgress,
} from '../../shared/contract-ssh';
import type { ConnectionManager } from '../connections/contract';
import { describeConnectFailure } from './connect-failure';
import type { HostKeyInspection, pinHostKey, replaceHostKey } from './host-key';
import { parseSshTarget, sshTargetKey, sshTargetLabel, type SshTarget } from './ssh-command';
import { runWithSshContext, type SshRunContext } from './ssh-context';
import { appendDiagnostic, diagnosticsKeyFor } from './ssh-diagnostics';
import { parseHostSettings, type SshHostRecord, type SshHostStore } from './ssh-host-store';
import type { Attempt, AttemptRegistry } from './ssh-ipc-attempts';
import { text } from './ssh-ipc-input';
import { cancelledResult, type createLoginRetry } from './ssh-ipc-login';

type OpenProgress = Parameters<NonNullable<Parameters<ConnectionManager['open']>[1]>>[0];

/** Refuses an attempt that already ran, and one whose port forwards the user has not accepted. */
function assertCanConnect(attempt: Attempt, request: DesktopSshConnectRequest | undefined): void {
  if (attempt.state === 'connecting' || (attempt.state === 'restartable' && request?.forceRestart !== true)) {
    throw new Error('This connection attempt already ran. Check the address again.');
  }
  // Only when Mixdog could not build a config without the user's forwards: they apply, so the user must have accepted them.
  if ((attempt.inspection.summary?.forwards?.length ?? 0) > 0 && request?.acceptForwards !== true) {
    throw new Error('Confirm the port forwards before connecting.');
  }
}

type HostKeyDecision =
  | { refused: DesktopSshConnectResult }
  | { pin?: HostKeyInspection['pin']; replace?: HostKeyInspection['replace'] };

/**
 * What the pre-check saw decides, never what the renderer says: a revoked or
 * unreadable key is refused outright, a changed one only when the user typed the
 * server's name to replace it, an unknown one only after the user confirmed it.
 */
function decideHostKey(
  inspection: Readonly<HostKeyInspection>,
  request: DesktopSshConnectRequest | undefined
): HostKeyDecision {
  const { check } = inspection;
  if (check.status === 'revoked') {
    return { refused: { ok: false, failure: { kind: 'host-key-revoked', code: 'host-key-revoked' } } };
  }
  if (check.status === 'unreachable') {
    return {
      refused: {
        ok: false,
        failure: check.sshMissing
          ? { kind: 'ssh-missing', command: check.sshMissing.command, code: 'ssh-missing' }
          : { kind: 'failed', message: check.message, code: 'host-key-unreachable' },
      },
    };
  }
  if (check.status === 'changed') {
    const { replace } = inspection;
    const typed = typeof request?.replaceHostKey === 'string' ? request.replaceHostKey.trim().toLowerCase() : '';
    if (!replace || !typed || typed !== replace.host.toLowerCase()) {
      return {
        refused: {
          ok: false,
          failure: {
            kind: 'host-key-changed',
            previous: check.previous,
            current: check.current,
            code: 'host-key-changed',
          },
        },
      };
    }
    return { replace };
  }
  if (check.status === 'unknown') {
    if (request?.trustHostKey !== true || !inspection.pin)
      throw new Error('Confirm the server’s fingerprint before connecting.');
    return { pin: inspection.pin };
  }
  return {};
}

/** A jump chain is confirmed one server at a time: true while a hop's key is still to be saved. */
const hasPendingHop = (check: HostKeyInspection['check']): boolean =>
  check.status !== 'trusted' && 'hops' in check && !!check.hops?.some((hop) => hop.status === 'pending');

/** Tells the log and, unless the attempt was cancelled, the window how the connection is going. */
function progressReporter(sender: WebContents, attempt: Attempt): (progress: OpenProgress) => void {
  return (progress) => {
    appendDiagnostic(
      diagnosticsKeyFor(attempt.target),
      'phase',
      `${progress.phase}${progress.detail ? `: ${progress.detail}` : ''}`
    );
    if (attempt.cancelled || sender.isDestroyed()) return;
    const payload: DesktopSshProgress = { attemptId: attempt.token, ...progress };
    sender.send(DESKTOP_IPC.sshProgress, payload);
  };
}

/** The host-key pre-check: reads what the server presents and opens the attempt that connect and cancel name. */
export function createInspectHandler(deps: {
  attempts: AttemptRegistry;
  /** Settles once Mixdog's own known_hosts and ssh config are ready. */
  configured: Promise<unknown>;
  inspect(target: SshTarget): Promise<HostKeyInspection>;
}): (event: IpcMainInvokeEvent, rawTarget: unknown) => Promise<DesktopSshInspection> {
  return async (event, rawTarget) => {
    const target = parseSshTarget(text(rawTarget, 'target'));
    await deps.configured;
    const inspection = await deps.inspect(target);
    appendDiagnostic(diagnosticsKeyFor(target), 'log', `host key check: ${inspection.check.status}`);
    if (event.sender.isDestroyed()) throw new Error('The window closed before the host key was read.');
    const attempt = deps.attempts.register(event, target, inspection);
    return {
      attemptId: attempt.token,
      check: attempt.inspection.check,
      ...(attempt.inspection.summary ? { summary: attempt.inspection.summary } : {}),
    };
  };
}

export interface ConnectHandlerDeps {
  connections: Pick<ConnectionManager, 'isOpen' | 'open' | 'close'>;
  attempts: AttemptRegistry;
  store(): Promise<SshHostStore>;
  contextFor(record: SshHostRecord, extra?: SshRunContext): SshRunContext;
  view(record: SshHostRecord): DesktopSshHost;
  withLogin: ReturnType<typeof createLoginRetry>;
  /** Settles once Mixdog's own known_hosts and ssh config are ready. */
  configured: Promise<unknown>;
  pin: typeof pinHostKey;
  replaceKey: typeof replaceHostKey;
  now(): number;
  platform: NodeJS.Platform;
}

export function createConnectHandlers(deps: ConnectHandlerDeps): {
  open(
    record: SshHostRecord,
    target: SshTarget,
    onProgress?: Parameters<ConnectionManager['open']>[1],
    attempt?: Attempt,
    context?: SshRunContext
  ): Promise<DesktopSshConnectResult>;
  connect(event: IpcMainInvokeEvent, request: DesktopSshConnectRequest | undefined): Promise<DesktopSshConnectResult>;
} {
  const { connections, attempts, platform } = deps;
  const reserveHost = createHostReservations();

  /** Opens the server window and, once it is up, saves the server. A cancelled
   *  attempt neither saves nor leaves the window it just opened. */
  async function open(
    record: SshHostRecord,
    target: SshTarget,
    onProgress?: Parameters<ConnectionManager['open']>[1],
    attempt?: Attempt,
    context?: SshRunContext
  ): Promise<DesktopSshConnectResult> {
    try {
      await runWithSshContext(context ?? deps.contextFor(record), () =>
        connections.open(
          { id: record.id, name: record.name, target: record.target },
          onProgress,
          context?.forceRestart ? { forceRestart: true } : undefined
        )
      );
    } catch (error) {
      return { ok: false, failure: describeConnectFailure(error, target, platform) };
    }
    if (attempt?.cancelled) {
      if (!attempt.wasOpen) await connections.close(record.id).catch(() => undefined);
      return cancelledResult();
    }
    const saved = await (await deps.store()).save({ ...record, lastConnectedAt: deps.now() });
    return { ok: true, host: deps.view(saved) };
  }

  async function connect(
    event: IpcMainInvokeEvent,
    request: DesktopSshConnectRequest | undefined
  ): Promise<DesktopSshConnectResult> {
    const attempt = attempts.owned(event, request?.attemptId);
    await deps.configured;
    const restart = attempt.state === 'restartable';
    assertCanConnect(attempt, request);
    // Same validation as the per-server settings; a bad value is refused before anything is pinned or opened.
    const entered = parseHostSettings({
      identityFile: request?.settings?.identityFile,
      remoteCwd: request?.settings?.remoteCwd,
    });
    const decision: HostKeyDecision = attempt.keyHandled ? {} : decideHostKey(attempt.inspection, request);
    if ('refused' in decision) {
      attempts.drop(attempt);
      return decision.refused;
    }
    attempt.state = 'connecting';
    let releaseHost = (): void => undefined;
    try {
      const { target } = attempt;
      const reservation = reserveHost(await deps.store(), target);
      releaseHost = reservation.release;
      // The entered settings ride the record: contextFor puts the key file on this attempt's ssh argv, and open() saves them.
      const record: SshHostRecord = Object.keys(entered).length
        ? { ...reservation.record, settings: { ...reservation.record.settings, ...entered } }
        : reservation.record;
      attempt.recordId = record.id;
      attempt.wasOpen = connections.isOpen(record.id);
      // A live connection is reused without logging in again, so a new key or folder would be saved untested.
      if (
        attempt.wasOpen &&
        (Object.keys(entered) as Array<keyof typeof entered>).some(
          (key) => entered[key] !== reservation.record.settings?.[key]
        )
      ) {
        throw new Error('This server is already connected. Disconnect it first to change its login key or folder.');
      }
      if (decision.replace) await deps.replaceKey(decision.replace);
      else if (decision.pin) await deps.pin(decision.pin);
      attempt.keyHandled = true;
      if (attempt.cancelled) return cancelledResult();
      // A jump chain is confirmed one server at a time: this key is saved, the next one is checked.
      if (hasPendingHop(attempt.inspection.check)) return { ok: false, failure: { kind: 'host-key-next' } };
      const onProgress = progressReporter(event.sender, attempt);
      const base = deps.contextFor(record, restart ? { forceRestart: true } : {});
      const result = await deps.withLogin(
        event.sender,
        attempt.token,
        sshTargetLabel(target),
        base,
        (context) => open(record, target, onProgress, attempt, context),
        () => attempt.cancelled
      );
      // A daemon outside proxy mode, or one of another version, is the failure
      // the attempt outlives: the user may restart exactly that connection.
      if (
        !result.ok &&
        (result.failure.kind === 'daemon-running' || result.failure.kind === 'daemon-busy') &&
        !attempt.cancelled
      ) {
        attempt.state = 'restartable';
      }
      return result;
    } finally {
      releaseHost();
      if (attempt.state === 'connecting') attempts.drop(attempt);
    }
  }

  return { open, connect };
}

/**
 * One id per target that is being connected for the first time: concurrent
 * attempts (two windows, a retry beside a slow first try) share it, so the same
 * server is never saved twice under different ids. The host name part of the
 * target is compared without regard to case.
 */
function createHostReservations(): (
  hosts: SshHostStore,
  target: SshTarget
) => { record: SshHostRecord; release(): void } {
  const reservations = new Map<string, { id: string; users: number }>();
  return (hosts, target) => {
    const saved = hosts.findByTarget(target.display);
    if (saved) return { record: saved, release: () => undefined };
    const key = sshTargetKey(target);
    const held = reservations.get(key) ?? { id: randomUUID(), users: 0 };
    held.users += 1;
    reservations.set(key, held);
    return {
      record: { id: held.id, name: sshTargetLabel(target), target: target.display, lastConnectedAt: null },
      release: () => {
        held.users -= 1;
        if (held.users === 0 && reservations.get(key) === held) reservations.delete(key);
      },
    };
  };
}
