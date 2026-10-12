// Credentials, browser registration and the approval handoff.
import type { RelayE2EEPairingMaterial } from '../shared/remote-e2ee';
import { earlyUiT } from './early-ui-i18n';
import {
  REMOTE_PAIRING_STORAGE_KEYS,
  clearStoredRemotePairing,
  isRemoteClientCredential,
} from './remote-pairing-recovery';
import { browserProfile, newBrowserId } from './remote-browser-identity';
import { createRemotePairingScreen } from './remote-pairing-screen';
import { clearRemoteConnectionState, setRemoteConnectionPhase } from './remote-connection-state';
import {
  DEVICE_STORAGE_KEY,
  REMOTE_CREDENTIAL_READY_EVENT,
  REMOTE_CONNECTION_READY_EVENT,
  REMOTE_PAIRING_INVALID_EVENT,
} from './remote-shim-state';
import type { RemoteShimContext } from './remote-shim-state';

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

  /** What an approval hands back: a credential minted for THIS container, plus
   *  E2EE material that travelled sealed to a key only this container holds. */
  const persistApproval = (credential: string, material: RelayE2EEPairingMaterial): boolean => {
    try {
      const keys = ctx.pairingKeys;
      localStorage.setItem(keys.server, ctx.serverBase || location.origin);
      // The origin-wide label catalog-storage-scope reads.
      localStorage.setItem(REMOTE_PAIRING_STORAGE_KEYS.server, ctx.serverBase || location.origin);
      localStorage.setItem(keys.token, credential);
      localStorage.setItem(keys.e2eePublicKey, material.serverPublicKey);
      localStorage.setItem(keys.e2eeSecret, material.pairingSecret);
      localStorage.setItem(keys.browserId, ctx.browserId);
      if (ctx.deviceId) localStorage.setItem(DEVICE_STORAGE_KEY, ctx.deviceId);
      return true;
    } catch {
      return false;
    }
  };

  const waitForApprovedConnection = (): Promise<void> => {
    if (ctx.connectionReady) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        window.removeEventListener(REMOTE_CONNECTION_READY_EVENT, ready);
        window.removeEventListener(REMOTE_PAIRING_INVALID_EVENT, invalid);
      };
      const ready = () => {
        cleanup();
        resolve();
      };
      const invalid = (event: Event) => {
        cleanup();
        const message =
          event instanceof CustomEvent && typeof event.detail === 'string'
            ? event.detail
            : earlyUiT('Could not complete the connection.');
        reject(new Error(message));
      };
      window.addEventListener(REMOTE_CONNECTION_READY_EVENT, ready, { once: true });
      window.addEventListener(REMOTE_PAIRING_INVALID_EVENT, invalid, { once: true });
    });
  };

  /** An approval this container may keep: stored first, because a credential
   *  that cannot be stored is a refused approval rather than a half pairing. */
  const adoptApproval = (credential: string, material: RelayE2EEPairingMaterial): boolean => {
    if (!persistApproval(credential, material)) return false;
    ctx.rosterCache.clear();
    ctx.token = credential;
    ctx.e2eePairing = material;
    // Claim approval already minted this browser's credential server-side.
    ctx.clientRegistered = true;
    window.dispatchEvent(new Event(REMOTE_CREDENTIAL_READY_EVENT));
    return true;
  };

  /** Dial with the fresh credential and answer once THIS connection is secure.
   *  The in-flight flag is the shim's: it keeps a completing handshake from
   *  removing the entry screen while its own verification is still running. */
  const verifyApprovedConnection = async (): Promise<void> => {
    ctx.approvalVerificationInFlight = true;
    const verified = waitForApprovedConnection();
    void ctx.connect().catch(() => {
      // Transient failures stay on the reconnect loop. Permanent pairing
      // failures raise REMOTE_PAIRING_INVALID_EVENT and end this attempt.
    });
    try {
      await verified;
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
    ctx.resetDeltaState();
    clearRemoteConnectionState();
    try {
      clearStoredRemotePairing(localStorage, ctx.pairingKeys);
      if (ctx.deviceId) localStorage.setItem(DEVICE_STORAGE_KEY, ctx.deviceId);
    } catch {
      /* private storage */
    }
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
    verifyApprovedConnection,
    resetApprovalAndAsk,
  });
};
