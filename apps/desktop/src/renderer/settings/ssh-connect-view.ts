import type {
  DesktopSshFailure,
  DesktopSshHopKey,
  DesktopSshHostKeyCheck,
  DesktopSshPhase,
} from '../../shared/contract-ssh';
import type { GuidanceFailure } from './ssh-guidance';

/** What the connect dialog shows; each kind replaces the content in place. */
export type View =
  | { kind: 'input' }
  | {
      kind: 'steps';
      phase: DesktopSshPhase;
      details: Partial<Record<DesktopSshPhase, string>>;
      sawInstall: boolean;
    }
  | { kind: 'trust'; fingerprint: string; keyType: string; hops?: DesktopSshHopKey[] }
  | {
      kind: 'changed';
      previous?: string;
      current?: string;
      /** Set while the attempt is alive: the name to type, the command that forgets the old key, and whether Mixdog may replace the key itself (it is in Mixdog's own known_hosts). */
      replace?: { host: string; command: string; replaceable: boolean };
      hops?: DesktopSshHopKey[];
    }
  | { kind: 'failure'; failure: GuidanceFailure }
  /** The user's ssh config forwards ports that Mixdog could not set aside: shown once, before the key check or the connection. */
  | { kind: 'forwards'; forwards: string[] }
  | { kind: 'daemon'; busy: boolean; pid: number | null };

export const START_VIEW: View = { kind: 'steps', phase: 'connect', details: {}, sawInstall: false };

export function viewForFailure(failure: DesktopSshFailure): View {
  if (failure.kind === 'host-key-changed')
    return { kind: 'changed', previous: failure.previous, current: failure.current };
  if (failure.kind === 'daemon-running') return { kind: 'daemon', busy: false, pid: failure.pid };
  if (failure.kind === 'daemon-busy') return { kind: 'daemon', busy: true, pid: null };
  if (failure.kind === 'cancelled' || failure.kind === 'host-key-next') return { kind: 'input' };
  return { kind: 'failure', failure };
}

export function viewForHostKey(check: Exclude<DesktopSshHostKeyCheck, { status: 'trusted' }>): View {
  if (check.status === 'changed') {
    return {
      kind: 'changed',
      previous: check.previous,
      current: check.current,
      replace: { host: check.host, command: check.removeCommand, replaceable: check.replaceable },
      hops: check.hops,
    };
  }
  if (check.status === 'unknown')
    return { kind: 'trust', fingerprint: check.fingerprint, keyType: check.keyType, hops: check.hops };
  if (check.status === 'revoked') return { kind: 'failure', failure: { kind: 'host-key-revoked' } };
  if (check.sshMissing) return { kind: 'failure', failure: { kind: 'ssh-missing', command: check.sshMissing.command } };
  return { kind: 'failure', failure: { kind: 'failed', message: check.message } };
}
