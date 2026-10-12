// Relay-owned Web Push, desktop side (relay: lib/web-push-legs.mjs).
//
// The relay owns the one VAPID identity every PC delivers through, so a
// browser subscribed once hears from all of its paired PCs. For each browser
// that registered this PC (with this PC's own pairing credential) the relay
// hands over `{ endpoint, clientId, sealed }`; `sealed` is the browser's
// p256dh/auth sealed to this desktop's E2EE identity, opened only here. The
// payload is encrypted for the subscription (RFC 8291) on this machine, and
// the relay — which signs VAPID and posts it — carries ciphertext only.
import { openRelayWebPushKeys, type RelayE2EEServerIdentity } from '../shared/remote-e2ee';

export interface RelayWebPushTarget {
  endpoint: string;
  /** The paired browser credential the association was made with. */
  clientId: string;
  p256dh: string;
  auth: string;
}

export interface RelayWebPush {
  /** The CURRENT relay connection advertised `webPush`. */
  available(): boolean;
  /** Every subscription this PC may deliver to, keys opened. */
  list(): Promise<RelayWebPushTarget[]>;
  /** Hands one encrypted (aes128gcm) body to the relay; false when it cannot. */
  send(target: Pick<RelayWebPushTarget, 'endpoint' | 'clientId'>, body: Buffer): boolean;
  /** A `webpush-subscriptions` frame: the relay's full set for this PC. */
  update(envelope: Record<string, unknown>): void;
  /** A `webpush-result` frame. */
  onResult(envelope: Record<string, unknown>): void;
  /** A new relay connection: nothing the previous one said survives. */
  reset(): void;
}

interface RelayWebPushDeps {
  identity: RelayE2EEServerIdentity;
  available(): boolean;
  sendEnvelope(payload: unknown): boolean;
  onDiagnostic?(event: string, details: Record<string, unknown>): void;
}

const MAX_TARGETS = 64;

export function createRelayWebPush(deps: RelayWebPushDeps): RelayWebPush {
  // Opened keys by sealed box: a republished set re-opens only what changed.
  const opened = new Map<string, RelayWebPushTarget | null>();
  let targets: Promise<RelayWebPushTarget[]> = Promise.resolve([]);
  let generation = 0;
  let announced = false;

  const openRow = async (row: Record<string, unknown>): Promise<RelayWebPushTarget | null> => {
    const endpoint = typeof row.endpoint === 'string' ? row.endpoint : '';
    const clientId = typeof row.clientId === 'string' ? row.clientId : '';
    const sealed = row.sealed as { ciphertext?: unknown } | null;
    if (!endpoint || !clientId || !sealed || typeof sealed.ciphertext !== 'string') return null;
    const cacheKey = `${endpoint}\n${clientId}\n${sealed.ciphertext}`;
    if (opened.has(cacheKey)) return opened.get(cacheKey) ?? null;
    const keys = await openRelayWebPushKeys(deps.identity, endpoint, sealed);
    const target = keys ? { endpoint, clientId, ...keys } : null;
    if (!target) {
      // Sealed for a pairing this PC no longer has; the browser re-seals on
      // its next launch.
      deps.onDiagnostic?.('suppressed', { browser: clientId.slice(0, 8), reason: 'unopenable-subscription' });
    }
    opened.set(cacheKey, target);
    return target;
  };

  return {
    available: deps.available,
    list: () => targets,
    send(target, body) {
      if (!deps.available()) return false;
      return deps.sendEnvelope({
        type: 'webpush-send',
        endpoint: target.endpoint,
        clientId: target.clientId,
        payload: body.toString('base64url'),
        urgency: 'high',
      });
    },
    update(envelope) {
      // The relay only lists subscriptions to a PC it delivers for: say, once
      // per connection, that this PC delivers through it. Browsers register
      // only with PCs that did, and keep an older PC on its own key.
      if (!announced && deps.available()) {
        announced = deps.sendEnvelope({ type: 'webpush-ready', version: 1 });
      }
      const rows = Array.isArray(envelope.subscriptions)
        ? (envelope.subscriptions as unknown[])
            .filter((row): row is Record<string, unknown> => Boolean(row) && typeof row === 'object')
            .slice(0, MAX_TARGETS)
        : [];
      const mine = ++generation;
      const next = Promise.all(rows.map(openRow)).then((rowsOpened) =>
        rowsOpened.filter((row): row is RelayWebPushTarget => row !== null)
      );
      targets = next;
      void next.then(() => {
        if (mine !== generation) return;
        // Forget boxes the relay no longer lists.
        const live = new Set(
          rows.map((row) => `${row.endpoint}\n${row.clientId}\n${(row.sealed as { ciphertext?: unknown })?.ciphertext}`)
        );
        for (const key of opened.keys()) if (!live.has(key)) opened.delete(key);
      });
    },
    onResult(envelope) {
      const target = {
        browser: String(envelope.clientId ?? '').slice(0, 8),
        ...(typeof envelope.status === 'number' ? { status: envelope.status } : {}),
      };
      if (envelope.ok === true) deps.onDiagnostic?.('delivered', target);
      else if (envelope.expired === true) deps.onDiagnostic?.('expired', target);
      else deps.onDiagnostic?.('failed', { ...target, error: String(envelope.error ?? 'unknown').slice(0, 80) });
    },
    reset() {
      announced = false;
      generation += 1;
      targets = Promise.resolve([]);
    },
  };
}
