// Credentials, browser registration and the approval handoff.
import type { RelayE2EEPairingMaterial } from '../shared/remote-e2ee';
import { earlyUiT } from './early-ui-i18n';
import {
  REMOTE_PAIRING_STORAGE_KEYS,
  clearStoredRemotePairing,
  isRemoteClientCredential,
} from './remote-pairing-recovery';
import { browserProfile, newBrowserId } from './remote-browser-identity';
import {
  clearDurablePairing,
  loadDurablePairing,
  saveDurablePairing,
  type DurablePairing,
} from './remote-pairing-durable';
import { createRemotePairingScreen } from './remote-pairing-screen';
import { clearControllerKey } from './remote-screen-controller-key';
import { clearRemoteConnectionState, setRemoteConnectionPhase } from './remote-connection-state';
import {
  DEVICE_STORAGE_KEY,
  REMOTE_CREDENTIAL_READY_EVENT,
  REMOTE_PAIRING_INVALID_EVENT,
  REMOTE_SECURE_CHANNEL_READY_EVENT,
} from './remote-shim-state';
import type { RemoteShimContext } from './remote-shim-state';

/** How long one dial of a fresh approval may take to become secure before it
 *  is dropped and redialed. */
export const APPROVED_CONNECTION_ATTEMPT_MS = 35_000;

export const installRemotePairing = (ctx: RemoteShimContext): void => {
  // Another tab shares localStorage and may have re-registered this browser,
  // rotating the per-browser credential; always dial with the freshest one.
  const currentToken = (): string => {
    try {
      const stored = localStorage.getItem(ctx.pairingKeys.token) || '';
      if (stored && isRemoteClientCredential(stored)) ctx.token = stored;
    } catch {
      /* keep the in-memory token */
    }
    return ctx.token;
  };

  // React mounts behind the pairing layer and immediately asks for snapshots.
  // Those calls must wait for the approval handoff instead of registering with
  // an empty token and turning a healthy in-progress claim into a 401 reset.
  const waitForCredential = (): Promise<void> => {
    if (currentToken() && ctx.e2eePairing) return Promise.resolve();
    setRemoteConnectionPhase('approval');
    return new Promise((resolve) => {
      const ready = () => {
        if (!currentToken() || !ctx.e2eePairing) return;
        window.removeEventListener(REMOTE_CREDENTIAL_READY_EVENT, ready);
        resolve();
      };
      window.addEventListener(REMOTE_CREDENTIAL_READY_EVENT, ready);
    });
  };

  const wsUrl = (): string => {
    const auth = encodeURIComponent(currentToken());
    if (ctx.serverBase) {
      const base = new URL(ctx.serverBase);
      const scheme = base.protocol === 'https:' ? 'wss' : 'ws';
      return `${scheme}://${base.host}/ws?token=${auth}`;
    }
    const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
    return `${scheme}://${location.host}/ws?token=${auth}`;
  };

  const ensureClientRegistration = (): Promise<void> => {
    if (ctx.clientRegistered) return Promise.resolve();
    // Single flight: the app fires several RPCs at startup and every one dials
    // connect(). Parallel registrations would each rotate this browser's
    // credential server-side, invalidating each other mid-pairing.
    ctx.registrationInFlight ??= (async () => {
      setRemoteConnectionPhase('registration');
      const endpoint = ctx.serverBase
        ? new URL('/client/register', ctx.serverBase).toString()
        : new URL('/client/register', location.origin).toString();
      const auth = currentToken();
      const response = await fetch(endpoint, {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
          // localStorage outlives cookies in installed PWAs; the bearer keeps
          // registration working when the pairing cookie is gone.
          ...(auth ? { Authorization: `Bearer ${auth}` } : {}),
        },
        body: JSON.stringify({ clientId: ctx.browserId, ...(await browserProfile()) }),
      });
      if (!response.ok) {
        const failure: Error & { status?: number } = new Error(
          `Remote browser registration failed (${response.status}).`
        );
        failure.status = response.status;
        throw failure;
      }
      const result = (await response.json()) as { clientId?: unknown; token?: unknown };
      if (typeof result.clientId === 'string' && result.clientId) {
        ctx.browserId = result.clientId;
        try {
          localStorage.setItem(ctx.pairingKeys.browserId, ctx.browserId);
        } catch {
          /* session only */
        }
      }
      if (typeof result.token === 'string' && isRemoteClientCredential(result.token)) {
        ctx.token = result.token;
        try {
          localStorage.setItem(ctx.pairingKeys.token, ctx.token);
        } catch {
          /* session only */
        }
      }
      ctx.clientRegistered = true;
    })().finally(() => {
      ctx.registrationInFlight = null;
    });
    return ctx.registrationInFlight;
  };

  // The pre-credential surface (remote-pairing-screen.ts) owns the entry screen
  // and the approval loop; the shim keeps what is connection state. Created
  // here so the install offer, which fires once and early, is still captured
  // before anything else can run.
  const showPairingScreen = createRemotePairingScreen({
    deviceId: ctx.deviceId,
    claimStorageKey: ctx.pairingKeys.claim,
    serverBase: () => ctx.serverBase || location.origin,
    clientId: () => ctx.browserId,
    acceptApproval: (credential, material) => adoptApproval(credential, material),
    verifyConnection: () => verifyApprovedConnection(),
  });

  /** Write a restored or approved pairing into localStorage under this
   *  container's keys. */
  const writeLocalPairing = (pairing: DurablePairing): void => {
    const keys = ctx.pairingKeys;
    localStorage.setItem(keys.server, pairing.server);
    // The origin-wide label catalog-storage-scope reads.
    localStorage.setItem(REMOTE_PAIRING_STORAGE_KEYS.server, pairing.server);
    localStorage.setItem(keys.token, pairing.token);
    localStorage.setItem(keys.e2eePublicKey, pairing.e2eePublicKey);
    localStorage.setItem(keys.e2eeSecret, pairing.e2eeSecret);
    localStorage.setItem(keys.browserId, pairing.browserId);
    if (ctx.deviceId) localStorage.setItem(DEVICE_STORAGE_KEY, ctx.deviceId);
  };

  /** Set while the durable copy holds a credential this container dropped
   *  (revoked, incomplete, or an approval rolled back) and its delete has not
   *  committed yet: boot must never adopt that copy. A flag, never a token. */
  const durableRevokedKey = (): string => `${ctx.pairingKeys.token}.revoked`;
  const markDurableRevoked = (): void => {
    try {
      localStorage.setItem(durableRevokedKey(), '1');
    } catch {
      /* no storage: the durable copy is the only one left to delete */
    }
  };
  /** Delete the durable copy; the revoked flag goes only once that commits. */
  const dropDurablePairing = async (): Promise<void> => {
    await clearDurablePairing(ctx.pairingKeys.token);
    try {
      localStorage.removeItem(durableRevokedKey());
    } catch {
      /* the flag stays; restore retries the delete */
    }
  };
  const dropLocalCredential = (): void => {
    try {
      const keys = ctx.pairingKeys;
      for (const key of [keys.token, keys.e2eePublicKey, keys.e2eeSecret]) localStorage.removeItem(key);
    } catch {
      /* nothing was written */
    }
  };

  /** What an approval hands back: a credential minted for THIS container, plus
   *  E2EE material that travelled sealed to a key only this container holds.
   *  Nothing usable is published before the durable copy has committed — the
   *  one that survives an OS trimming this web app's localStorage — and a
   *  failure after it rolls both back. */
  const persistApproval = async (credential: string, material: RelayE2EEPairingMaterial): Promise<boolean> => {
    const pairing: DurablePairing = {
      token: credential,
      e2eePublicKey: material.serverPublicKey,
      e2eeSecret: material.pairingSecret,
      browserId: ctx.browserId,
      server: ctx.serverBase || location.origin,
    };
    try {
      await saveDurablePairing(ctx.pairingKeys.token, pairing);
    } catch {
      return false;
    }
    try {
      // The committed copy is this approval now, not a revoked one.
      localStorage.removeItem(durableRevokedKey());
      writeLocalPairing(pairing);
      return true;
    } catch {
      dropLocalCredential();
      markDurableRevoked();
      await dropDurablePairing().catch(() => undefined);
      return false;
    }
  };

  /** localStorage came back without this container's credential: take the
   *  durable copy, if one was committed, and put it back. */
  const restoreDurablePairing = async (): Promise<void> => {
    let revoked = false;
    try {
      revoked = localStorage.getItem(durableRevokedKey()) === '1';
    } catch {
      /* no storage: nothing says the copy was dropped */
    }
    if (revoked) {
      // This container dropped that credential; its delete failed last time.
      await dropDurablePairing().catch(() => undefined);
      return;
    }
    let pairing: DurablePairing | null = null;
    try {
      pairing = await loadDurablePairing(ctx.pairingKeys.token);
    } catch {
      return;
    }
    if (!pairing || !isRemoteClientCredential(pairing.token)) return;
    try {
      writeLocalPairing(pairing);
    } catch {
      /* this session still runs on the restored copy */
    }
    ctx.token = pairing.token;
    ctx.e2eePairing = { version: 1, serverPublicKey: pairing.e2eePublicKey, pairingSecret: pairing.e2eeSecret };
    ctx.browserId = pairing.browserId;
    ctx.serverBase = pairing.server;
    // The relay may have dropped this browser's registration meanwhile; the
    // bearer credential re-registers it.
    ctx.clientRegistered = false;
    // Calls the app made while this was read are waiting for a credential.
    window.dispatchEvent(new Event(REMOTE_CREDENTIAL_READY_EVENT));
  };

  /** Resolves once the E2EE channel to the PC is up — not after the view
   *  sync, which a busy PC can take seconds over and which the app retries
   *  on its own — or `false` after `ms`. Rejects only on a pairing the PC
   *  refused. */
  const waitForSecureChannel = (ms: number): Promise<boolean> => {
    if (ctx.connectionReady && ctx.socket?.readyState === WebSocket.OPEN) return Promise.resolve(true);
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        window.clearTimeout(timer);
        window.removeEventListener(REMOTE_SECURE_CHANNEL_READY_EVENT, ready);
        window.removeEventListener(REMOTE_PAIRING_INVALID_EVENT, invalid);
      };
      const ready = () => {
        cleanup();
        resolve(true);
      };
      const invalid = (event: Event) => {
        cleanup();
        const message =
          event instanceof CustomEvent && typeof event.detail === 'string'
            ? event.detail
            : earlyUiT('Could not complete the connection.');
        reject(new Error(message));
      };
      const timer = window.setTimeout(() => {
        cleanup();
        resolve(false);
      }, ms);
      window.addEventListener(REMOTE_SECURE_CHANNEL_READY_EVENT, ready);
      window.addEventListener(REMOTE_PAIRING_INVALID_EVENT, invalid);
    });
  };

  /** An approval this container may keep: stored first, because a credential
   *  that cannot be stored is a refused approval rather than a half pairing. */
  const adoptApproval = async (credential: string, material: RelayE2EEPairingMaterial): Promise<boolean> => {
    if (!(await persistApproval(credential, material))) return false;
    ctx.rosterCache.clear();
    ctx.visualizePages.clear();
    ctx.token = credential;
    ctx.e2eePairing = material;
    // Claim approval already minted this browser's credential server-side.
    ctx.clientRegistered = true;
    window.dispatchEvent(new Event(REMOTE_CREDENTIAL_READY_EVENT));
    return true;
  };

  /** Dial with the fresh credential and answer once THIS connection is secure.
   *  A connection problem is never a failure here: an attempt that is not
   *  secure within APPROVED_CONNECTION_ATTEMPT_MS is dropped and the reconnect
   *  loop redials with the stored credential (jittered backoff, capped at
   *  10 s) while "Allowed. Connecting…" stays up — never a new claim. Only a
   *  pairing the PC refused ends it. The in-flight flag is the shim's: it
   *  keeps a completing handshake from removing the entry screen while its
   *  own verification is still running. */
  const verifyApprovedConnection = async (): Promise<void> => {
    ctx.approvalVerificationInFlight = true;
    try {
      void ctx.connect().catch(() => {
        // Transient failures stay on the reconnect loop. Permanent pairing
        // failures raise REMOTE_PAIRING_INVALID_EVENT and end this attempt.
      });
      while (!(await waitForSecureChannel(APPROVED_CONNECTION_ATTEMPT_MS))) {
        if (ctx.retireConnection) ctx.retireConnection();
        else if (ctx.reconnectTimer === null) void ctx.connect().catch(() => {});
      }
    } finally {
      ctx.approvalVerificationInFlight = false;
    }
  };

  // This credential is unrecoverable. Wipe it and hand the surface back to the
  // entry screen, which asks the desktop for a new approval; the device route
  // survives because it is a routing label, not a credential.
  const resetApprovalAndAsk = (message: string): void => {
    ctx.viewBaselines.clear();
    ctx.rosterCache.clear();
    ctx.visualizePages.clear();
    ctx.resetDeltaState();
    clearRemoteConnectionState();
    try {
      clearStoredRemotePairing(localStorage, ctx.pairingKeys);
      if (ctx.deviceId) localStorage.setItem(DEVICE_STORAGE_KEY, ctx.deviceId);
    } catch {
      /* private storage */
    }
    // A refused credential must not come back from its durable copy, even if
    // the delete fails and the app reloads before it is retried.
    markDurableRevoked();
    void dropDurablePairing().catch(() => undefined);
    // The secure-desktop helper's controller key belonged to this pairing.
    void clearControllerKey(ctx.pairingKeys.token).catch(() => undefined);
    ctx.serverBase = location.origin;
    ctx.token = '';
    ctx.e2eePairing = null;
    ctx.everPaired = false;
    ctx.browserId = newBrowserId();
    ctx.clientRegistered = false;
    showPairingScreen(message, false);
    window.dispatchEvent(new CustomEvent(REMOTE_PAIRING_INVALID_EVENT, { detail: message }));
  };

  Object.assign(ctx, {
    currentToken,
    waitForCredential,
    wsUrl,
    ensureClientRegistration,
    showPairingScreen,
    adoptApproval,
    restoreDurablePairing,
    verifyApprovedConnection,
    resetApprovalAndAsk,
  });
};
