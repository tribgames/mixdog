import type { DesktopAgentPoolRow, DesktopSessionSummary } from '../shared/contract';
import type {
  DesktopServiceMethod,
  SerializableDesktopServiceOptions,
} from './desktop-service-contract';

export type DesktopServiceInbound =
  | { kind: 'init'; options: SerializableDesktopServiceOptions }
  | { kind: 'request'; id: number; method: DesktopServiceMethod; args: unknown[] }
  /** Fire-and-forget lane: no response frame, no pending entry, no timeout.
   *  Terminal keystrokes and resizes ride it so a keypress never queues behind
   *  a session request's round trip. */
  | { kind: 'notify'; method: DesktopServiceMethod; args: unknown[] }
  | { kind: 'state-ack'; sequence: number }
  | { kind: 'session-state-resync'; sessionId: string }
  | { kind: 'state-resync' };

export interface DesktopServiceError {
  name: string;
  message: string;
  code?: string;
}

export type DesktopServiceOutbound =
  | { kind: 'ready' }
  /** The daemon behind a still-open transport was replaced. Everything the
   *  dead process hosted went with it — the relay leg above all — and no
   *  second `ready` announces the swap, because the transport itself never
   *  dropped. This frame is what says so. */
  | { kind: 'daemon-replaced' }
  | { kind: 'response'; id: number; ok: true; value: unknown }
  | { kind: 'response'; id: number; ok: false; error: DesktopServiceError }
  | { kind: 'state'; sequence: number; wire: unknown }
  | {
    kind: 'session-state';
    sessionId: string;
    wire: unknown;
    frameSource: 'live' | 'replay';
    contentRevision?: number;
    laneEnd?: 'gone' | 'unloaded' | 'disconnected';
  }
  | { kind: 'sessions'; sessions: DesktopSessionSummary[] }
  | { kind: 'agent-pool'; agents: DesktopAgentPoolRow[] }
  | { kind: 'desktop-event'; name: string; value: unknown };

export interface LatestStateMailbox<T> {
  publish(value: T): void;
  acknowledge(sequence: number): void;
  reset(value: T): void;
  clear(): void;
}

/** One state frame may cross the transport boundary at a time. While it is in
 * flight, publications collapse to the newest value; skipped snapshots are
 * never encoded, so revisions stay contiguous and the connection cannot build
 * an unbounded serialization backlog. */
export function createLatestStateMailbox<T>(
  send: (sequence: number, value: T) => void,
): LatestStateMailbox<T> {
  let latest: T | undefined;
  let inFlight: number | null = null;
  let nextSequence = 1;
  const flush = (): void => {
    if (inFlight !== null || latest === undefined) return;
    const value = latest;
    latest = undefined;
    const sequence = nextSequence++;
    inFlight = sequence;
    try {
      send(sequence, value);
    } catch (error) {
      inFlight = null;
      latest = value;
      throw error;
    }
  };
  return {
    publish(value): void {
      latest = value;
      flush();
    },
    acknowledge(sequence): void {
      if (sequence !== inFlight) return;
      inFlight = null;
      flush();
    },
    reset(value): void {
      inFlight = null;
      latest = value;
      flush();
    },
    clear(): void {
      inFlight = null;
      latest = undefined;
    },
  };
}
