// The main PC's 6-digit pairing code (pairing v2). It exists only while
// Settings → Connection is open: the renderer asks for it (`ensure`) on a
// short heartbeat and releases it when the screen closes. The relay holds the
// code → device-route mapping; it is valid for five minutes and single use, so
// a code the renderer stops asking for dies on its own. A code is a secret of
// a few minutes' life and is never logged here or sent anywhere but the relay.
import { randomBytes } from 'node:crypto';

export const PAIR_CODE_TTL_MS = 300_000;
/** How long a request may go unanswered before the relay is judged too old to
 *  issue codes (it ignores the frame). */
export const PAIR_CODE_REQUEST_TIMEOUT_MS = 5_000;
/** While the screen stays open, the next code is requested this long before
 *  the shown one expires, so the screen never sits on an expired code. */
export const PAIR_CODE_RENEW_BEFORE_MS = 30_000;

export interface PairCodeState {
  /** Six digits, no separator. */
  code: string;
  expiresAt: number;
}

/** The relay cannot issue codes (older relay, or it refused); show no code. */
export interface PairCodeUnsupported {
  unsupported: true;
}

export interface PairCodeManager {
  /** The relay-issued live code; `null` while a request is outstanding;
   *  `{ unsupported: true }` when the relay never answered or refused. A code
   *  is only ever returned after the relay issued it. */
  ensure(renew?: boolean): PairCodeState | PairCodeUnsupported | null;
  /** The screen closed: withdraw the code from the relay. */
  release(): void;
  /** The relay answered a `pair-code-request`. */
  onIssued(envelope: Record<string, unknown>): void;
  /** The relay redeemed a code; only the lease that owns it is spent. */
  onUsed(envelope: Record<string, unknown>): void;
  /** A relay leg opened: it holds nothing of ours, so ask for a fresh code. */
  onConnected(): void;
}

export function createPairCodeManager(deps: {
  /** Returns whether the frame was actually written to an open socket. */
  sendEnvelope(payload: unknown): boolean;
  /** Read per request, so a rename applies to the next code. */
  hostName: string | (() => string);
  now?: () => number;
  newLease?: () => string;
  requestTimeoutMs?: number;
}): PairCodeManager {
  const now = deps.now ?? Date.now;
  const newLease = deps.newLease ?? (() => randomBytes(16).toString('hex'));
  const timeoutMs = deps.requestTimeoutMs ?? PAIR_CODE_REQUEST_TIMEOUT_MS;
  let current: (PairCodeState & { lease: string }) | null = null;
  let pending: { lease: string; at: number } | null = null;
  let active = false;
  let unsupported = false;

  const live = (): PairCodeState | null => (current && current.expiresAt > now() ? current : null);
  const request = (): void => {
    const lease = newLease();
    if (
      deps.sendEnvelope({
        type: 'pair-code-request',
        lease,
        name: typeof deps.hostName === 'function' ? deps.hostName() : deps.hostName,
      })
    ) {
      pending = { lease, at: now() };
    }
  };
  const view = (): PairCodeState | null => {
    const existing = live();
    return existing ? { code: existing.code, expiresAt: existing.expiresAt } : null;
  };

  return {
    ensure(renew = false) {
      active = true;
      if (pending && now() - pending.at > timeoutMs) {
        pending = null;
        unsupported = true;
      }
      if (unsupported) return { unsupported: true };
      if (renew) {
        current = null;
        pending = null;
      }
      const existing = view();
      if (existing) {
        // The relay keeps one code per PC, so the reply replaces this one.
        if (!pending && existing.expiresAt - now() <= PAIR_CODE_RENEW_BEFORE_MS) request();
        return existing;
      }
      current = null;
      if (!pending) request();
      return null;
    },
    release() {
      active = false;
      const held = current !== null || pending !== null;
      current = null;
      pending = null;
      if (held) deps.sendEnvelope({ type: 'pair-code-clear' });
    },
    onIssued(envelope) {
      if (!pending || envelope.lease !== pending.lease) return;
      const lease = pending.lease;
      pending = null;
      const ttl = envelope.expiresInMs;
      if (
        envelope.ok !== true ||
        typeof envelope.code !== 'string' ||
        !/^\d{6}$/u.test(envelope.code) ||
        typeof ttl !== 'number' ||
        !(ttl > 0)
      ) {
        unsupported = true;
        return;
      }
      current = { code: envelope.code, expiresAt: now() + Math.min(ttl, PAIR_CODE_TTL_MS), lease };
    },
    onUsed(envelope) {
      if (current && envelope.lease === current.lease) current = null;
    },
    onConnected() {
      current = null;
      pending = null;
      unsupported = false;
      if (active) request();
    },
  };
}
