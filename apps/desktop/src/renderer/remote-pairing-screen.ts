// Everything the phone does before it holds a credential: the entry screen it
// shows, and the approval it asks the desktop for. Vanilla DOM keeps recovery
// working before React mounts and even when the socket cannot open.
import {
  exportRelayClaimKeyPair,
  generateRelayClaimKeyPair,
  importRelayClaimKeyPair,
  openSealedRelayE2EEPairingMaterial,
  type RelayClaimKeyPair,
  type RelayE2EEPairingMaterial,
} from '../shared/remote-e2ee';
import { earlyUiT } from './early-ui-i18n';
import { isInstalledMobileWebAppSurface, isMobileRemoteSurface } from './mobile-surface';
import { browserProfile } from './remote-browser-identity';
import { REMOTE_PAIRING_STORAGE_KEYS } from './remote-pairing-recovery';

const CLAIM_STORAGE_KEY = REMOTE_PAIRING_STORAGE_KEYS.claim;

/** The screen's status line. A failed status keeps the retry button visible. */
type PairingStatus = (text: string, failed?: boolean) => void;

export interface RemotePairingScreenDeps {
  /** The route this container captured at install time — the ONE thing it
   *  knows about the desktop that may approve it. */
  deviceId: string;
  /** The relay origin to ask, read per attempt because a credential reset
   *  returns it to this page's own origin. */
  serverBase: () => string;
  /** This container's id, which a re-registration may have rotated. */
  clientId: () => string;
  /** Store and adopt an approval. False is a refused approval — a credential
   *  that cannot be stored is never a half pairing. */
  acceptApproval: (credential: string, material: RelayE2EEPairingMaterial) => boolean;
  /** Dial with the fresh credential and resolve once the secure channel is
   *  ready; the rejection carries the text this screen shows. */
  verifyConnection: () => Promise<void>;
}

// The request already waiting on the desktop, kept across reloads: a phone OS
// discards a backgrounded web app freely, and a forgotten request would mean
// asking again — one more prompt on the desktop for the same connection.
const savePendingClaim = async (claimId: string, keyPair: RelayClaimKeyPair): Promise<void> => {
  try {
    localStorage.setItem(
      CLAIM_STORAGE_KEY,
      JSON.stringify({
        claimId,
        keyPair: await exportRelayClaimKeyPair(keyPair),
      })
    );
  } catch {
    /* the approval still completes while this page lives */
  }
};

const loadPendingClaim = async (): Promise<{
  claimId: string;
  keyPair: RelayClaimKeyPair;
} | null> => {
  try {
    const raw = localStorage.getItem(CLAIM_STORAGE_KEY) || '';
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { claimId?: unknown; keyPair?: unknown };
    const keyPair = await importRelayClaimKeyPair(parsed.keyPair);
    if (!keyPair || typeof parsed.claimId !== 'string' || !parsed.claimId) return null;
    return { claimId: parsed.claimId, keyPair };
  } catch {
    return null;
  }
};

const clearPendingClaim = (): void => {
  try {
    localStorage.removeItem(CLAIM_STORAGE_KEY);
  } catch {
    /* private storage */
  }
};

// Approval instead of a scan. This container holds no credential and cannot
// inherit one, so it asks the desktop its own entry route names, and the
// answer comes back sealed to a key generated right here — the relay routes
// the request and can open none of it.
const requestApproval = async (
  deps: RemotePairingScreenDeps,
  layer: HTMLElement,
  onStatus: PairingStatus
): Promise<void> => {
  const deviceId = deps.deviceId;
  if (!deviceId) {
    onStatus(earlyUiT('Open the link from your desktop QR code once to install this app.'), true);
    return;
  }
  const base = deps.serverBase();
  // Resuming beats asking: the desktop may already be showing the prompt for
  // the request this app opened before it was discarded.
  const resumed = await loadPendingClaim();
  const keyPair = resumed?.keyPair ?? (await generateRelayClaimKeyPair());
  let claimId = resumed?.claimId ?? '';
  const profile = await browserProfile();
  const wait = (ms: number): Promise<void> =>
    new Promise((done) => {
      window.setTimeout(done, ms);
    });
  const open = async (): Promise<string> => {
    const response = await fetch(new URL('/claim', base).toString(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        deviceId,
        clientId: deps.clientId(),
        publicKey: keyPair.publicKey,
        ...profile,
      }),
    });
    // 503 is the desktop being asleep or offline, which resolves itself.
    if (response.status === 503) return '';
    if (!response.ok) throw new Error(`claim refused (${response.status})`);
    const body = (await response.json()) as { claimId?: unknown };
    return typeof body.claimId === 'string' ? body.claimId : '';
  };
  for (;;) {
    if (!claimId) {
      try {
        claimId = await open();
      } catch {
        onStatus(earlyUiT('This desktop no longer recognises this app. Scan its QR code again.'), true);
        return;
      }
      if (!claimId) {
        onStatus(earlyUiT('Waiting for your desktop to come online…'));
        await wait(5_000);
        continue;
      }
      await savePendingClaim(claimId, keyPair);
    }
    onStatus(earlyUiT('Waiting for approval on your desktop…'));
    const deadline = Date.now() + 300_000;
    let outcome = 'expired';
    while (Date.now() < deadline) {
      await wait(2_000);
      let payload: { status?: unknown; token?: unknown; sealed?: unknown };
      try {
        const response = await fetch(new URL(`/claim/${encodeURIComponent(claimId)}`, base).toString(), {
          headers: { Accept: 'application/json' },
        });
        if (!response.ok) continue;
        payload = (await response.json()) as typeof payload;
      } catch {
        continue;
      }
      const status = String(payload?.status || 'pending');
      if (status === 'pending') continue;
      if (status !== 'approved') {
        outcome = status;
        break;
      }
      const material = await openSealedRelayE2EEPairingMaterial(payload.sealed, keyPair);
      const credential = String(payload.token || '');
      // A box that does not open is a refused approval, never a half pairing.
      if (!material || !/^[0-9a-f]{32,128}$/u.test(credential) || !deps.acceptApproval(credential, material)) {
        clearPendingClaim();
        onStatus(earlyUiT('That approval could not be verified.'), true);
        return;
      }
      onStatus(earlyUiT('Approval received. Verifying the secure connection…'));
      try {
        await deps.verifyConnection();
      } catch (error) {
        onStatus(error instanceof Error ? error.message : String(error), true);
        return;
      }
      clearPendingClaim();
      layer.classList.add('mrp-ok');
      const waitTitle = layer.querySelector<HTMLElement>('[data-role="wait-title"]');
      if (waitTitle) waitTitle.textContent = earlyUiT('Success');
      onStatus(earlyUiT('Securely connected. Opening Mixdog…'));
      try {
        navigator.vibrate?.([30, 60, 30]);
      } catch {
        /* no haptics */
      }
      window.setTimeout(() => layer.remove(), 900);
      return;
    }
    clearPendingClaim();
    onStatus(
      outcome === 'denied' ? earlyUiT('The request was declined on your desktop.') : earlyUiT('The request expired.'),
      true
    );
    return;
  }
};

/**
 * Entry screen, vanilla DOM so it works before React mounts and with no
 * socket at all. Two states, decided by what this container IS: a browser
 * gets the install guide (the installed app is what pairs, never the
 * browser), and an installed app asks this desktop for approval.
 *
 * Chromium's install offer fires once and early — possibly before the entry
 * screen exists — so it is captured here and replayed when that screen mounts.
 */
export const createRemotePairingScreen = (
  deps: RemotePairingScreenDeps
): ((message: string, autoAsk?: boolean) => void) => {
  let installPrompt: (Event & { prompt(): Promise<void> }) | null = null;
  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    installPrompt = event as Event & { prompt(): Promise<void> };
    document.querySelector('#mixdog-remote-pairing [data-role="install"]')?.removeAttribute('hidden');
  });
  return (message: string, autoAsk = true): void => {
    if (document.getElementById('mixdog-remote-pairing')) return;
    const mobile = isMobileRemoteSurface();
    const standalone = isInstalledMobileWebAppSurface();
    const ios =
      /iPad|iPhone|iPod/iu.test(navigator.userAgent) ||
      (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    const mount = () => {
      const layer = document.createElement('div');
      layer.id = 'mixdog-remote-pairing';
      const threeSteps =
        '<ol><li><i>1</i><span data-role="step-one"></span></li>' +
        '<li><i>2</i><span data-role="step-two"></span></li>' +
        '<li><i>3</i><span data-role="step-three"></span></li></ol>';
      const twoSteps =
        '<ol><li><i>1</i><span data-role="step-one"></span></li>' +
        '<li><i>2</i><span data-role="step-two"></span></li></ol>';
      let cardBody: string;
      if (standalone) {
        cardBody =
          '<div class="mrp-wait"><i aria-hidden="true"></i>' +
          '<b data-role="wait-title"></b></div>' +
          '<p class="mrp-status" data-role="status"></p>' +
          '<button type="button" data-role="ask" hidden></button>';
      } else if (!mobile) {
        cardBody = threeSteps;
      } else {
        cardBody = `${ios ? threeSteps : twoSteps}<button type="button" data-role="install" hidden></button>`;
      }
      layer.innerHTML =
        '<style>' +
        '#mixdog-remote-pairing{position:fixed;inset:0;z-index:9999;display:grid;place-items:center;' +
        'padding:24px;background:#0e0e0e;color:#e9e9e9;font:400 15px/22px system-ui,sans-serif;}' +
        '#mixdog-remote-pairing *{box-sizing:border-box;margin:0;}' +
        '#mixdog-remote-pairing [hidden]{display:none!important;}' +
        '@keyframes mrp-rise{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}' +
        '#mixdog-remote-pairing .mrp-card{display:grid;gap:14px;justify-items:center;width:100%;' +
        'max-width:344px;padding:28px 22px calc(28px + env(safe-area-inset-bottom));' +
        'border-radius:22px;background:#17171a;text-align:center;' +
        'animation:mrp-rise 280ms ease-out both;}' +
        '#mixdog-remote-pairing img{width:54px;height:54px;}' +
        '#mixdog-remote-pairing b{font-size:18px;line-height:24px;}' +
        '#mixdog-remote-pairing p{color:#a8a8a8;font-size:13.5px;line-height:19px;}' +
        '#mixdog-remote-pairing ol{display:grid;gap:7px;width:100%;padding:0;list-style:none;' +
        'text-align:left;}' +
        '#mixdog-remote-pairing li{display:flex;align-items:center;gap:10px;padding:10px 12px;' +
        'border-radius:12px;background:rgba(255,255,255,.07);font-size:13px;line-height:18px;}' +
        '#mixdog-remote-pairing li i{flex:none;display:grid;place-items:center;width:20px;height:20px;' +
        'border-radius:50%;background:rgba(255,255,255,.14);font-size:11.5px;font-style:normal;' +
        'font-weight:700;}' +
        '@keyframes mrp-spin{to{transform:rotate(360deg)}}' +
        '#mixdog-remote-pairing .mrp-wait{display:grid;gap:12px;justify-items:center;width:100%;' +
        'padding:20px 12px;border-radius:16px;background:rgba(255,255,255,.07);}' +
        '#mixdog-remote-pairing .mrp-wait i{width:26px;height:26px;border-radius:50%;' +
        'border:2.5px solid rgba(255,255,255,.18);border-top-color:#e9e9e9;' +
        'animation:mrp-spin 900ms linear infinite;}' +
        '#mixdog-remote-pairing.mrp-ok .mrp-wait i{border-color:#4ac885;animation:none;}' +
        '#mixdog-remote-pairing .mrp-wait b{font-size:15px;line-height:20px;}' +
        '#mixdog-remote-pairing .mrp-status{min-height:19px;color:#a8a8a8;font-size:13px;line-height:19px;}' +
        '#mixdog-remote-pairing .mrp-status.mrp-bad{color:#e5484d;}' +
        '#mixdog-remote-pairing button{width:100%;padding:13px;border:0;border-radius:12px;' +
        'background:#e9e9e9;color:#111114;font:600 15px/20px system-ui,sans-serif;cursor:pointer;}' +
        '</style>' +
        '<main class="mrp-card">' +
        '<img src="/mixdog.svg" alt="" draggable="false"/>' +
        '<b data-role="heading"></b>' +
        '<p data-role="note"></p>' +
        cardBody +
        '</main>';
      // Catalog text enters only textContent, never HTML.
      let heading = earlyUiT('Install Mixdog on your phone');
      if (standalone) heading = earlyUiT('Approve this device');
      else if (mobile) heading = earlyUiT('Install Mixdog');
      let stepOne = earlyUiT('Open this page on your phone or tablet');
      let stepTwo = earlyUiT('Install Mixdog from the mobile browser');
      if (mobile) {
        stepOne = ios ? earlyUiT('Tap the Share button') : earlyUiT('Install Mixdog from your browser menu');
        stepTwo = ios ? earlyUiT('Choose Add to Home Screen') : earlyUiT('Open it and approve it on your desktop');
      }
      const labels: Record<string, string> = {
        heading,
        'wait-title': earlyUiT('Waiting for approval'),
        ask: earlyUiT('Ask again'),
        install: earlyUiT('Install'),
        'step-one': stepOne,
        'step-two': stepTwo,
        'step-three': !mobile
          ? earlyUiT('Open the installed app and approve it on your desktop')
          : earlyUiT('Open Mixdog and approve it on your desktop'),
      };
      for (const [role, label] of Object.entries(labels)) {
        const target = layer.querySelector<HTMLElement>(`[data-role="${role}"]`);
        if (target) target.textContent = label;
      }
      const note = layer.querySelector<HTMLElement>('[data-role="note"]');
      if (note) {
        if (standalone) {
          note.textContent = message || earlyUiT('Mixdog needs a one-time approval from the desktop it belongs to.');
        } else if (mobile) {
          note.textContent = earlyUiT(
            'Mixdog runs as an installed mobile app. Install it, then approve it once on your desktop.'
          );
        } else {
          note.textContent = earlyUiT('The Mixdog web app works only when installed on a mobile device.');
        }
      }
      const install = layer.querySelector<HTMLButtonElement>('[data-role="install"]');
      if (install && installPrompt) install.removeAttribute('hidden');
      install?.addEventListener('click', () => {
        void installPrompt?.prompt().catch(() => {
          /* the browser menu still works */
        });
      });
      document.body.appendChild(layer);
      if (!standalone) return;
      const status = layer.querySelector<HTMLElement>('[data-role="status"]');
      const ask = layer.querySelector<HTMLButtonElement>('[data-role="ask"]');
      const setStatus = (text: string, failed?: boolean): void => {
        if (status) {
          status.textContent = text;
          status.classList.toggle('mrp-bad', failed === true);
        }
        // A failure waits for a deliberate retry. Asking again on its own is
        // exactly what turns one connection into prompt after prompt on the
        // desktop (user: 인증받고 그 화면인데도 계속 또 나오고).
        if (failed) ask?.removeAttribute('hidden');
      };
      const start = (): void => {
        ask?.setAttribute('hidden', '');
        setStatus('', false);
        void requestApproval(deps, layer, setStatus).catch(() => {
          setStatus(earlyUiT('Could not reach the relay. Check this device’s connection.'), true);
        });
      };
      ask?.addEventListener('click', start);
      if (autoAsk) start();
      else setStatus(message || earlyUiT('Open Settings → Connection, then ask again.'), true);
    };
    if (document.body) mount();
    else window.addEventListener('DOMContentLoaded', mount, { once: true });
  };
};
