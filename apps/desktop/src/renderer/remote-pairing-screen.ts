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
import { nativeAppInfo } from '../shared/native-app';
import {
  isInstalledMobileWebAppSurface,
  isIOSWebSurface,
  isMobileDeviceSurface,
  markDirectBrowserSurface,
} from './mobile-surface';
import { browserProfile } from './remote-browser-identity';
import { isRemoteClientCredential } from './remote-pairing-recovery';

// The one-time ticket a 6-digit code was redeemed for (`#pair=<ticket>` on the
// route the code page or the phone app sent us to). It rides the first claim so
// the main PC's approval dialog can say "6-digit code"; the relay, not this
// page, decides whether it is genuine. Taken off the address bar at once.
let pairTicket = '';
// This pairing began from a 6-digit code, so a claim sent without its (spent)
// ticket is a retry of that pairing, not a QR scan.
let startedFromCode = false;
// The PC's name, when the code page or the app redeemed it (`&host=<name>`).
let pairHostName = '';
const takeTicketFromAddress = (): void => {
  const match = /^#pair=([0-9a-f]{32})(?:&host=([^&]*))?$/u.exec(location.hash);
  if (!match) return;
  pairTicket = match[1];
  startedFromCode = true;
  try {
    pairHostName = decodeURIComponent(match[2] ?? '')
      .trim()
      .slice(0, 80);
  } catch {
    pairHostName = '';
  }
  try {
    history.replaceState(null, '', `${location.pathname}${location.search}`);
  } catch {
    /* the ticket is already held */
  }
};

/** Whether this host takes a browser tab directly (pairing v2). An old host
 *  keeps the install gate; one that is offline right now cannot say, and the
 *  approval loop waits for it to come back. */
const hostAllowsDirectBrowser = async (deviceId: string, base: string): Promise<boolean> => {
  if (!deviceId) return false;
  const url = `${new URL('/pair-code/support', base).toString()}?deviceId=${encodeURIComponent(deviceId)}`;
  try {
    // The relay throttles this probe (429): wait out a short Retry-After once
    // instead of dropping a capable host to the install guide. Only
    // online/pairV2 are read — the host name is no longer served here.
    let response = await fetch(url, { signal: AbortSignal.timeout(3_000) });
    if (response.status === 429) {
      const seconds = Number(response.headers.get('Retry-After'));
      await new Promise((done) => window.setTimeout(done, Math.min(Number.isFinite(seconds) ? seconds : 1, 3) * 1_000));
      response = await fetch(url, { signal: AbortSignal.timeout(3_000) });
    }
    if (!response.ok) return false;
    const body = (await response.json()) as { online?: unknown; pairV2?: unknown };
    return body.online !== true || body.pairV2 === true;
  } catch {
    return false;
  }
};

/** What the pairing screen is told while a request runs; it paints one step per event. */
type PairingEvent =
  | { kind: 'waiting' }
  | { kind: 'offline' }
  | { kind: 'allowed' }
  | { kind: 'done' }
  | { kind: 'fail'; title: string; sub: string };
type PairingReport = (event: PairingEvent) => void;

const failure = (sub: string): PairingEvent => ({ kind: 'fail', title: earlyUiT('Connection failed'), sub });
const declinedEvent = (): PairingEvent => ({
  kind: 'fail',
  title: earlyUiT('Request declined'),
  sub: earlyUiT('Your PC declined the request.'),
});
const expiredEvent = (): PairingEvent => ({
  kind: 'fail',
  title: earlyUiT('Request expired'),
  sub: earlyUiT('Connect again to send a new request.'),
});
const networkEvent = (): PairingEvent => ({
  kind: 'fail',
  title: earlyUiT('Connection failed'),
  sub: earlyUiT('Check your internet connection.'),
});

/** States the screenshot switch can render (shared names with the phone app and /connect). */
export const PAIRING_PREVIEW_STATES = [
  'start-empty',
  'start-with-pcs',
  'code',
  'code-error',
  'code-ratelimited',
  'waiting',
  'waiting-offline',
  'declined',
  'expired',
  'revoked',
  'network-error',
  'outdated',
  'scan-unavailable',
] as const;

/** `?mxPairingPreview=<state>`, honored only when localStorage
 *  `mixdog.debug.pairingPreview` is "1". */
export const pairingPreviewState = (): (typeof PAIRING_PREVIEW_STATES)[number] | null => {
  try {
    if (localStorage.getItem('mixdog.debug.pairingPreview') !== '1') return null;
    const name = new URLSearchParams(location.search).get('mxPairingPreview');
    return PAIRING_PREVIEW_STATES.find((state) => state === name) ?? null;
  } catch {
    return null;
  }
};

// The same full-screen column as the phone app's picker and /connect: logo,
// title and subtitle in one place on every step, content under them, actions
// flowing right under it. Identical rule text in all three surfaces.
const PAIRING_CSS =
  '.mxp-screen{position:fixed;inset:0;height:100vh;height:100dvh;max-height:100dvh;box-sizing:border-box;overflow:hidden;display:grid;grid-template-columns:minmax(0,1fr);grid-template-rows:minmax(0,1fr);justify-items:center;padding:env(safe-area-inset-top) env(safe-area-inset-right) calc(env(safe-area-inset-bottom) + var(--mxp-kb,0px)) env(safe-area-inset-left);background:#0e0e0e;color:#e9e9e9;font-family:system-ui,-apple-system,"Segoe UI","Noto Sans KR","Apple SD Gothic Neo","Malgun Gothic",sans-serif;font-size:15px;line-height:22px;font-weight:400}.mxp-screen *{box-sizing:border-box;margin:0}.mxp-screen [hidden]{display:none!important}.mxp-col{width:calc(100% - 40px);max-width:340px;height:100%;min-height:0;overflow:auto;padding:max(16px,calc(45vh - 190px)) 0 16px;padding-top:max(16px,calc(45dvh - 190px))}.mxp-main{text-align:center}.mxp-block{width:100%;display:flex;flex-direction:column;align-items:center}.mxp-vis{flex:none;width:48px;height:48px}.mxp-logo{display:block;width:48px;height:48px}.mxp-title{flex:none;width:100%;height:30px;margin-top:20px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:22px;line-height:30px;font-weight:700}.mxp-sub{flex:none;width:100%;height:45px;margin-top:8px;overflow:hidden;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;color:#a8a8a8;font-size:15px;line-height:22.5px;word-break:keep-all;overflow-wrap:normal;text-wrap:balance}.mxp-extra{flex:none;width:100%;height:80px;margin-top:24px;display:flex;flex-direction:column;align-items:center;gap:8px}.mxp-block.steps .mxp-extra{height:auto;gap:12px}.mxp-actions{width:100%;margin-top:24px;display:grid;gap:8px;align-content:start}.mxp-actions .mxp-fine{text-align:center}.mxp-btn{width:100%;min-height:48px;padding:0 16px;display:flex;align-items:center;justify-content:center;border:0;border-radius:12px;background:#e9e9e9;color:#111114;font-family:inherit;font-size:15px;line-height:20px;font-weight:700;cursor:pointer}.mxp-btn.sec{min-height:44px;background:transparent;color:#a8a8a8}.mxp-btn:disabled{opacity:.45;cursor:default}.mxp-otp{position:relative;flex:none;width:100%;height:52px;display:flex;justify-content:center;gap:8px}.mxp-digit{flex:1 1 0;min-width:0;max-width:44px;height:52px;display:flex;align-items:center;justify-content:center;border:1px solid rgba(255,255,255,.2);border-radius:10px;font:700 22px/1 ui-monospace,Consolas,monospace}.mxp-digit:nth-child(3){margin-right:8px}.mxp-digit.on{border-color:#e9e9e9;box-shadow:0 0 0 1px #e9e9e9}.mxp-code{position:absolute;inset:0;width:100%;height:100%;padding:0;border:0;opacity:0;background:transparent;color:transparent;caret-color:transparent;font-size:16px}.mxp-error{min-height:20px;color:#ff8b8f;font-size:13px;line-height:20px}@media (max-width:599px){.mxp-code-step .mxp-col{display:flex;flex-direction:column;align-items:center;padding-top:max(24px,7dvh)}.mxp-code-step .mxp-main,.mxp-code-step .mxp-block{display:contents}.mxp-code-step .mxp-title{height:auto;min-height:30px;white-space:normal}.mxp-code-step .mxp-sub{height:auto;display:block;overflow:visible}.mxp-code-step .mxp-extra{height:auto;margin-top:auto;padding-top:24px}.mxp-code-step .mxp-actions{margin-top:16px}}.mxp-wait{display:flex;align-items:center;justify-content:center;gap:8px;color:#a8a8a8;font-size:14px;line-height:20px}.mxp-spinner{flex:none;width:16px;height:16px;border:2px solid rgba(255,255,255,.18);border-top-color:#a8a8a8;border-radius:50%;animation:mxp-spin 1.1s linear infinite}@keyframes mxp-spin{to{transform:rotate(360deg)}}@media (prefers-reduced-motion:reduce){.mxp-spinner{animation:none;border:0;width:6px;height:6px;margin:5px;background:#a8a8a8}}.mxp-fine{color:#7a7a80;font-size:12px;line-height:17px}.mxp-step{width:100%;padding:10px 14px;border-radius:12px;background:rgba(255,255,255,.06);font-size:14px;line-height:20px;text-align:left}.mxp-step b{margin-right:10px;color:#8a8a92}';
const PAIRING_OVERLAY_CSS = '#mixdog-remote-pairing{z-index:9999}';

interface PairingAction {
  role: 'ask' | 'cancel' | 'back' | 'install';
  label: string;
  primary: boolean;
  hidden?: boolean;
}
interface PairingView {
  title: string;
  sub: string;
  /** The part of `sub` shown bold (the PC name). */
  subBold?: string;
  /** The "Waiting…" row in the middle slot. */
  wait?: boolean;
  steps: string[];
  fine?: string;
  actions: PairingAction[];
}

interface RemotePairingScreenDeps {
  /** The route this container captured at install time — the ONE thing it
   *  knows about the desktop that may approve it. */
  deviceId: string;
  /** Where this desktop's pending claim is kept (per relay origin + device). */
  claimStorageKey: string;
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
const savePendingClaim = async (storageKey: string, claimId: string, keyPair: RelayClaimKeyPair): Promise<void> => {
  try {
    localStorage.setItem(
      storageKey,
      JSON.stringify({
        claimId,
        keyPair: await exportRelayClaimKeyPair(keyPair),
      })
    );
  } catch {
    /* the approval still completes while this page lives */
  }
};

const loadPendingClaim = async (
  storageKey: string
): Promise<{
  claimId: string;
  keyPair: RelayClaimKeyPair;
} | null> => {
  try {
    const raw = localStorage.getItem(storageKey) || '';
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { claimId?: unknown; keyPair?: unknown };
    const keyPair = await importRelayClaimKeyPair(parsed.keyPair);
    if (!keyPair || typeof parsed.claimId !== 'string' || !parsed.claimId) return null;
    return { claimId: parsed.claimId, keyPair };
  } catch {
    return null;
  }
};

const clearPendingClaim = (storageKey: string): void => {
  try {
    localStorage.removeItem(storageKey);
  } catch {
    /* private storage */
  }
};

// Approval instead of a scan. This container holds no credential and cannot
// inherit one, so it asks the desktop its own entry route names, and the
// answer comes back sealed to a key generated right here — the relay routes
// the request and can open none of it.
// The in-flight requests of each layer's current run, so a cancel or retry
// aborts them instead of only ignoring their answers.
const runAborters = new WeakMap<HTMLElement, AbortController>();
const abortRun = (layer: HTMLElement): void => {
  runAborters.get(layer)?.abort();
  runAborters.delete(layer);
};
// The run's signal bounded by a timeout. AbortSignal.any is missing before
// Chrome 116 / Safari 17.4, where calling it failed every pairing as a
// network error, so the two are joined by hand.
const runSignal = (run: AbortSignal, ms: number): AbortSignal => {
  const joined = new AbortController();
  const abort = (): void => joined.abort();
  if (run.aborted) abort();
  else run.addEventListener('abort', abort, { once: true });
  const timer = window.setTimeout(abort, ms);
  joined.signal.addEventListener('abort', () => window.clearTimeout(timer), { once: true });
  return joined.signal;
};

const requestApproval = async (
  deps: RemotePairingScreenDeps,
  layer: HTMLElement,
  onReport: PairingReport
): Promise<void> => {
  // A newer run (retry) or a cancel supersedes this one.
  const run = layer.dataset.run;
  const stale = (): boolean => layer.dataset.run !== run;
  abortRun(layer);
  const aborter = new AbortController();
  runAborters.set(layer, aborter);
  const report: PairingReport = (event) => {
    if (!stale()) onReport(event);
  };
  const deviceId = deps.deviceId;
  if (!deviceId) {
    report(failure(earlyUiT('Scan the QR code on your PC to install this app.')));
    return;
  }
  const base = deps.serverBase();
  // Resuming beats asking: the desktop may already be showing the prompt for
  // the request this app opened before it was discarded.
  const resumed = await loadPendingClaim(deps.claimStorageKey);
  const keyPair = resumed?.keyPair ?? (await generateRelayClaimKeyPair());
  let claimId = resumed?.claimId ?? '';
  const profile = await browserProfile();
  const wait = (ms: number): Promise<void> =>
    new Promise((done) => {
      window.setTimeout(done, ms);
    });
  const open = async (): Promise<string> => {
    let ticketFields: { ticket?: string; retry?: boolean } = {};
    if (pairTicket) ticketFields = { ticket: pairTicket };
    else if (startedFromCode) ticketFields = { retry: true };
    const response = await fetch(new URL('/claim', base).toString(), {
      signal: runSignal(aborter.signal, 15_000),
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        deviceId,
        clientId: deps.clientId(),
        publicKey: keyPair.publicKey,
        ...ticketFields,
        ...profile,
      }),
    });
    // 503 is the desktop being asleep or offline, which resolves itself.
    if (response.status === 503) return '';
    if (!response.ok) throw new Error(`claim refused (${response.status})`);
    // A ticket is single use: once the claim exists it is spent.
    pairTicket = '';
    const body = (await response.json()) as { claimId?: unknown };
    return typeof body.claimId === 'string' ? body.claimId : '';
  };
  for (;;) {
    if (!claimId) {
      try {
        claimId = await open();
      } catch (error) {
        // Only a refusal means "scan again"; an unreachable relay is a network error.
        const refused = error instanceof Error && error.message.startsWith('claim refused');
        report(
          refused
            ? failure(earlyUiT('Your PC no longer recognizes this device. Scan the QR code again.'))
            : networkEvent()
        );
        return;
      }
      if (stale()) return;
      if (!claimId) {
        report({ kind: 'offline' });
        await wait(5_000);
        if (stale()) return;
        continue;
      }
      if (stale()) return;
      await savePendingClaim(deps.claimStorageKey, claimId, keyPair);
      // A cancel during the save must not leave a claim behind.
      if (stale()) {
        clearPendingClaim(deps.claimStorageKey);
        return;
      }
    }
    report({ kind: 'waiting' });
    const deadline = Date.now() + 300_000;
    let outcome = 'expired';
    let reachable = true;
    while (Date.now() < deadline) {
      await wait(2_000);
      if (stale()) return;
      let payload: { status?: unknown; token?: unknown; sealed?: unknown };
      try {
        const response = await fetch(new URL(`/claim/${encodeURIComponent(claimId)}`, base).toString(), {
          headers: { Accept: 'application/json' },
          // A stalled poll ends with the deadline, not after it.
          signal: runSignal(aborter.signal, Math.max(1, Math.min(10_000, deadline - Date.now()))),
        });
        if (!response.ok) {
          reachable = false;
          continue;
        }
        payload = (await response.json()) as typeof payload;
        reachable = true;
      } catch {
        reachable = false;
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
      // Every side effect below re-checks: a cancel while the answer was in
      // flight or being opened must store nothing.
      if (stale()) return;
      // A browser tab that was approved directly keeps running as the app.
      if (!isInstalledMobileWebAppSurface()) markDirectBrowserSurface();
      const directTab = layer.dataset.direct === '1';
      // A box that does not open is a refused approval, never a half pairing.
      if (!material || !isRemoteClientCredential(credential) || !deps.acceptApproval(credential, material)) {
        clearPendingClaim(deps.claimStorageKey);
        report(failure(earlyUiT('Could not verify the connection. Try again.')));
        return;
      }
      report({ kind: 'allowed' });
      try {
        await deps.verifyConnection();
      } catch (error) {
        report(failure(error instanceof Error ? error.message : String(error)));
        return;
      }
      if (stale()) return;
      clearPendingClaim(deps.claimStorageKey);
      report({ kind: 'done' });
      try {
        navigator.vibrate?.([30, 60, 30]);
      } catch {
        /* no haptics */
      }
      // The tab loaded as the lightweight page; reload so the app itself mounts
      // with the credential it now holds.
      window.setTimeout(() => {
        if (!stale()) directTab ? location.reload() : layer.remove();
      }, 900);
      return;
    }
    if (stale()) return;
    if (outcome === 'expired' && !reachable) {
      // The deadline passed while the relay was unreachable: not an expiry.
      report(networkEvent());
      return;
    }
    clearPendingClaim(deps.claimStorageKey);
    report(outcome === 'denied' ? declinedEvent() : expiredEvent());
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
  takeTicketFromAddress();
  let installPrompt: (Event & { prompt(): Promise<void> }) | null = null;
  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    installPrompt = event as Event & { prompt(): Promise<void> };
    document.querySelector('#mixdog-remote-pairing [data-role="install"]')?.removeAttribute('hidden');
  });
  return (message: string, autoAsk = true): void => {
    if (document.getElementById('mixdog-remote-pairing')) return;
    // Install instructions depend on the device, not on the current layout width.
    const mobile = isMobileDeviceSurface();
    const installed = isInstalledMobileWebAppSurface();
    const ios =
      /iPad|iPhone|iPod/iu.test(navigator.userAgent) ||
      (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    const mount = async () => {
      const preview = pairingPreviewState();
      // Pairing v2: a plain browser tab connects directly when its host takes
      // it; an old host keeps the install guide.
      const direct = !preview && !installed && (await hostAllowsDirectBrowser(deps.deviceId, deps.serverBase()));
      if (document.getElementById('mixdog-remote-pairing')) return;
      const previewInstallGuide = preview !== null && /^(start|code|outdated|scan)/u.test(preview);
      const standalone = preview ? !previewInstallGuide : installed || direct;
      const layer = document.createElement('div');
      layer.id = 'mixdog-remote-pairing';
      layer.className = 'mxp-screen';
      layer.dataset.run = '0';
      if (direct) layer.dataset.direct = '1';
      const style = document.createElement('style');
      style.textContent = PAIRING_CSS + PAIRING_OVERLAY_CSS;

      const pushNote =
        direct && isIOSWebSurface() && !nativeAppInfo()
          ? earlyUiT('Get notifications in the Mixdog app.')
          : undefined;
      const waitingView = (title: string, sub: string, fine?: string): PairingView => ({
        title,
        sub,
        wait: true,
        steps: [],
        fine,
        actions: [{ role: 'cancel', label: earlyUiT('Cancel'), primary: false }],
      });
      // A browser tab that connects directly has /connect to go back to.
      const canGoBack = direct || preview !== null;
      const retryView = (title: string, sub: string): PairingView => ({
        title,
        sub,
        steps: [],
        actions: [
          { role: 'ask', label: earlyUiT('Connect again'), primary: true },
          ...(canGoBack ? [{ role: 'back' as const, label: earlyUiT('Cancel'), primary: false }] : []),
        ],
      });
      const eventView = (event: PairingEvent): PairingView => {
        if (event.kind === 'waiting') {
          const pc = pairHostName || (preview === 'waiting' ? 'Home PC' : '');
          const view = waitingView(
            earlyUiT('Allow it on your PC'),
            pc
              ? earlyUiT('On {{pc}}, press Allow on the request.', { pc })
              : earlyUiT('Press Allow on the request shown on your PC.'),
            pushNote
          );
          return pc ? { ...view, subBold: pc } : view;
        }
        if (event.kind === 'offline') {
          return waitingView(earlyUiT('Waiting for your PC'), earlyUiT('Make sure Mixdog is running on your PC.'));
        }
        if (event.kind === 'allowed') {
          return { title: earlyUiT('Allowed. Connecting…'), sub: '', wait: true, steps: [], actions: [] };
        }
        if (event.kind === 'done') {
          return { title: earlyUiT('Success'), sub: earlyUiT('Connected. Opening Mixdog…'), steps: [], actions: [] };
        }
        return retryView(event.title, event.sub);
      };
      const endedView = (): PairingView =>
        retryView(earlyUiT('You were disconnected'), message || earlyUiT('Your PC disconnected this device.'));
      const installView = (): PairingView => {
        let stepOne = earlyUiT('Open this page on your phone or tablet');
        let stepTwo = earlyUiT('Install Mixdog from the mobile browser');
        if (mobile) {
          stepOne = ios ? earlyUiT('Tap the Share button') : earlyUiT('Install Mixdog from your browser menu');
          stepTwo = ios ? earlyUiT('Choose Add to Home Screen') : earlyUiT('Open it and allow it on your PC');
        }
        const stepThree = !mobile
          ? earlyUiT('Open the installed app and allow it on your PC')
          : earlyUiT('Open Mixdog and allow it on your PC');
        return {
          title: mobile ? earlyUiT('Install Mixdog') : earlyUiT('Install Mixdog on your phone'),
          sub: mobile
            ? earlyUiT('Add Mixdog to your home screen, then allow it on your PC.')
            : earlyUiT('Add Mixdog to your phone’s home screen to use it.'),
          steps: !mobile || ios ? [stepOne, stepTwo, stepThree] : [stepOne, stepTwo],
          actions: mobile
            ? [{ role: 'install', label: earlyUiT('Install'), primary: true, hidden: !installPrompt }]
            : [],
        };
      };

      const el = <K extends keyof HTMLElementTagNameMap>(
        tag: K,
        className = '',
        text = ''
      ): HTMLElementTagNameMap[K] => {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (text) node.textContent = text;
        return node;
      };
      // Catalog text enters only textContent, never HTML.
      const paint = (view: PairingView): void => {
        const col = el('div', 'mxp-col');
        const main = el('main', 'mxp-main');
        const block = el('div', view.steps.length ? 'mxp-block steps' : 'mxp-block');
        const vis = el('div', 'mxp-vis');
        const logo = el('img', 'mxp-logo');
        logo.src = '/mixdog-logo-titanium.svg';
        logo.alt = '';
        logo.draggable = false;
        vis.append(logo);
        const sub = el('p', 'mxp-sub');
        const at = view.subBold ? view.sub.indexOf(view.subBold) : -1;
        if (at < 0) sub.textContent = view.sub;
        else
          sub.append(
            view.sub.slice(0, at),
            el('b', '', view.subBold),
            view.sub.slice(at + (view.subBold?.length ?? 0))
          );
        block.append(vis, el('h1', 'mxp-title', view.title), sub);
        const extra = el('div', 'mxp-extra');
        view.steps.forEach((text, index) => {
          const step = el('div', 'mxp-step');
          step.append(el('b', '', String(index + 1)), el('span', '', text));
          extra.append(step);
        });
        if (view.wait) {
          const row = el('p', 'mxp-wait');
          row.append(el('i', 'mxp-spinner'), earlyUiT('Waiting…'));
          extra.append(row);
        }
        if (view.fine) extra.append(el('p', 'mxp-fine', view.fine));
        block.append(extra);
        main.append(block);
        const actions = el('footer', 'mxp-actions');
        for (const action of view.actions) {
          const button = el('button', `mxp-btn${action.primary ? '' : ' sec'}`, action.label);
          button.type = 'button';
          button.dataset.role = action.role;
          if (action.hidden) button.hidden = true;
          button.addEventListener('click', () => onAction(action.role));
          actions.append(button);
        }
        col.append(main, actions);
        layer.replaceChildren(style, col);
      };

      const report: PairingReport = (event) => paint(eventView(event));
      const start = (): void => {
        abortRun(layer);
        layer.dataset.run = String(Number(layer.dataset.run) + 1);
        report({ kind: 'waiting' });
        void requestApproval(deps, layer, report).catch(() => report(networkEvent()));
      };
      const cancel = (): void => {
        // Superseding the run stops the polling; a retry starts a fresh one.
        abortRun(layer);
        layer.dataset.run = String(Number(layer.dataset.run) + 1);
        clearPendingClaim(deps.claimStorageKey);
        paint(retryView(earlyUiT('Request canceled'), earlyUiT('Connect again to send a new request.')));
      };
      function onAction(role: PairingAction['role']): void {
        if (preview) return;
        if (role === 'ask') start();
        else if (role === 'back') location.assign('/connect');
        else if (role === 'cancel') cancel();
        else void installPrompt?.prompt().catch(() => undefined);
      }

      document.body.appendChild(layer);
      if (preview) {
        const events: Record<string, PairingEvent> = {
          waiting: { kind: 'waiting' },
          'waiting-offline': { kind: 'offline' },
          declined: declinedEvent(),
          expired: expiredEvent(),
          'network-error': networkEvent(),
        };
        if (preview === 'revoked') paint(endedView());
        else if (events[preview]) report(events[preview]);
        else paint(installView());
        return;
      }
      if (!standalone) {
        paint(installView());
        return;
      }
      if (autoAsk) start();
      else paint(endedView());
    };
    if (document.body) void mount();
    else window.addEventListener('DOMContentLoaded', () => void mount(), { once: true });
  };
};
