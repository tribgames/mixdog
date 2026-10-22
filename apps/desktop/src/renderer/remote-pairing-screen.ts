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
import { isInstalledMobileWebAppSurface, isIOSWebSurface, markDirectBrowserSurface } from './mobile-surface';
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
  'waiting',
  'waiting-offline',
  'declined',
  'expired',
  'revoked',
  'network-error',
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
  '.mxp-screen{--mxp-band:#181818;--mxp-text:#e9e9e9;--mxp-muted:#a8a8a8;--mxp-faint:#7a7a80;--mxp-radius:12px;--mxp-btn-h:48px;--mxp-btn-ink:#111114;--mxp-font:"Pretendard Variable",Pretendard,"Malgun Gothic","Segoe UI",-apple-system,"Apple SD Gothic Neo",sans-serif;--mxp-mono:"JetBrains Mono Variable","JetBrains Mono",Consolas,"SF Mono",Menlo,monospace;position:fixed;inset:0;height:100vh;height:100dvh;max-height:100dvh;box-sizing:border-box;overflow:hidden;display:grid;grid-template-columns:minmax(0,1fr);grid-template-rows:minmax(0,1fr);justify-items:center;padding:env(safe-area-inset-top) env(safe-area-inset-right) calc(env(safe-area-inset-bottom) + var(--mxp-kb,0px)) env(safe-area-inset-left);background:var(--mxp-band);color:var(--mxp-text);font-family:var(--mxp-font);font-size:15px;line-height:22px;font-weight:400}.mxp-screen *{box-sizing:border-box;margin:0}.mxp-screen [hidden]{display:none!important}.mxp-col{width:calc(100% - 40px);max-width:340px;height:100%;min-height:0;overflow:auto;padding:max(16px,calc(45vh - 190px)) 0 16px;padding-top:max(16px,calc(45dvh - 190px))}.mxp-main{text-align:center}.mxp-block{width:100%;display:flex;flex-direction:column;align-items:center}.mxp-vis{flex:none;width:48px;height:48px}.mxp-logo{display:block;width:48px;height:48px}.mxp-title{flex:none;width:100%;height:30px;margin-top:20px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:22px;line-height:30px;font-weight:700}.mxp-sub{flex:none;width:100%;height:45px;margin-top:8px;overflow:hidden;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;color:var(--mxp-muted);font-size:15px;line-height:22.5px;word-break:keep-all;overflow-wrap:normal;text-wrap:balance}.mxp-extra{flex:none;width:100%;height:80px;margin-top:24px;display:flex;flex-direction:column;align-items:center;gap:8px}.mxp-block.steps .mxp-extra{height:auto;gap:12px}.mxp-actions{width:100%;margin-top:24px;display:grid;gap:8px;align-content:start}.mxp-actions .mxp-fine{text-align:center}.mxp-btn{width:100%;min-height:var(--mxp-btn-h);padding:0 16px;display:flex;align-items:center;justify-content:center;border:0;border-radius:var(--mxp-radius);background:var(--mxp-text);color:var(--mxp-btn-ink);font-family:inherit;font-size:15px;line-height:20px;font-weight:700;cursor:pointer}.mxp-btn.sec{min-height:44px;background:transparent;color:var(--mxp-muted)}.mxp-btn:disabled{opacity:.45;cursor:default}.mxp-otp{position:relative;flex:none;width:100%;height:52px;display:flex;justify-content:center;gap:8px}.mxp-digit{flex:1 1 0;min-width:0;max-width:44px;height:52px;display:flex;align-items:center;justify-content:center;border:1px solid rgba(255,255,255,.2);border-radius:10px;font:700 22px/1 var(--mxp-mono)}.mxp-digit:nth-child(3){margin-right:8px}.mxp-digit.on{border-color:var(--mxp-text);box-shadow:0 0 0 1px var(--mxp-text)}.mxp-code{position:absolute;inset:0;width:100%;height:100%;padding:0;border:0;opacity:0;background:transparent;color:transparent;caret-color:transparent;font-size:16px}.mxp-error{min-height:20px;color:#ff8b8f;font-size:13px;line-height:20px}@media (max-width:599px){.mxp-code-step .mxp-col{display:flex;flex-direction:column;align-items:center;padding-top:max(24px,7dvh)}.mxp-code-step .mxp-main,.mxp-code-step .mxp-block{display:contents}.mxp-code-step .mxp-title{height:auto;min-height:30px;white-space:normal}.mxp-code-step .mxp-sub{height:auto;display:block;overflow:visible}.mxp-code-step .mxp-extra{height:auto;margin-top:auto;padding-top:24px}.mxp-code-step .mxp-actions{margin-top:16px}}.mxp-wait{display:flex;align-items:center;justify-content:center;gap:8px;color:var(--mxp-muted);font-size:14px;line-height:20px}.mxp-spinner{flex:none;width:16px;height:16px;border:2px solid rgba(255,255,255,.18);border-top-color:var(--mxp-muted);border-radius:50%;animation:mxp-spin 1.1s linear infinite}@keyframes mxp-spin{to{transform:rotate(360deg)}}@media (prefers-reduced-motion:reduce){.mxp-spinner{animation:none;border:0;width:6px;height:6px;margin:5px;background:var(--mxp-muted)}}.mxp-fine{color:var(--mxp-faint);font-size:12px;line-height:17px}.mxp-step{width:100%;padding:10px 14px;border-radius:var(--mxp-radius);background:rgba(255,255,255,.06);font-size:14px;line-height:20px;text-align:left}.mxp-step b{margin-right:10px;color:#8a8a92}.mxp-btn{text-decoration:none}.mxp-opt{display:grid;gap:8px}';
const PAIRING_OVERLAY_CSS = '#mixdog-remote-pairing{z-index:9999}';

interface PairingAction {
  role: 'ask' | 'cancel' | 'back';
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
  acceptApproval: (credential: string, material: RelayE2EEPairingMaterial) => Promise<boolean> | boolean;
  /** Dial with the fresh credential and resolve once the secure channel is
   *  ready, redialing on its own for as long as that takes; the rejection
   *  (a pairing the PC refused) carries the text this screen shows. */
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
    // A page frozen in the background thaws with the deadline already gone:
    // the loop still owes that wake one poll, which may well be the approval.
    for (let last = false; !last; ) {
      await wait(2_000);
      if (stale()) return;
      last = Date.now() >= deadline;
      let payload: { status?: unknown; token?: unknown; sealed?: unknown };
      try {
        const response = await fetch(new URL(`/claim/${encodeURIComponent(claimId)}`, base).toString(), {
          headers: { Accept: 'application/json' },
          // A stalled poll ends with the deadline, not after it; the final
          // poll gets the ordinary bound.
          signal: runSignal(aborter.signal, last ? 10_000 : Math.max(1, Math.min(10_000, deadline - Date.now()))),
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
      if (status === 'unknown') {
        outcome = status;
        break;
      }
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
      if (!material || !isRemoteClientCredential(credential) || !(await deps.acceptApproval(credential, material))) {
        clearPendingClaim(deps.claimStorageKey);
        report(failure(earlyUiT('Could not verify the connection. Try again.')));
        return;
      }
      if (stale()) return;
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
    if (outcome === 'unknown') {
      // The relay no longer knows this claim (it restarted, or dropped it):
      // nothing was decided, so the same key asks again on its own.
      clearPendingClaim(deps.claimStorageKey);
      claimId = '';
      continue;
    }
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
 * socket at all. Every container asks this desktop for approval: an installed
 * app, and a plain browser tab too (which then keeps running as the app). A
 * browser tab that knows no desktop goes to the code entry page instead.
 */
export const createRemotePairingScreen = (
  deps: RemotePairingScreenDeps
): ((message: string, autoAsk?: boolean, title?: string) => void) => {
  takeTicketFromAddress();
  return (message: string, autoAsk = true, title?: string): void => {
    if (document.getElementById('mixdog-remote-pairing')) return;
    const installed = isInstalledMobileWebAppSurface();
    const mount = () => {
      const preview = pairingPreviewState();
      // A plain browser tab pairs directly with the desktop its route names.
      const direct = !preview && !installed;
      if (direct && !deps.deviceId) {
        location.assign('/connect');
        return;
      }
      const layer = document.createElement('div');
      layer.id = 'mixdog-remote-pairing';
      layer.className = 'mxp-screen';
      layer.dataset.run = '0';
      if (direct) layer.dataset.direct = '1';
      const style = document.createElement('style');
      style.textContent = PAIRING_CSS + PAIRING_OVERLAY_CSS;

      const pushNote =
        direct && isIOSWebSurface() && !nativeAppInfo() ? earlyUiT('Get notifications in the Mixdog app.') : undefined;
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
        retryView(title || earlyUiT('You were disconnected'), message || earlyUiT('Your PC disconnected this device.'));
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
        else cancel();
      }

      document.body.appendChild(layer);
      // Nothing else sets --mxp-kb: lift the screen above the soft keyboard.
      const visual = window.visualViewport;
      if (visual) {
        const syncKeyboard = (): void => {
          if (!layer.isConnected) {
            visual.removeEventListener('resize', syncKeyboard);
            visual.removeEventListener('scroll', syncKeyboard);
            return;
          }
          const inset = Math.max(0, Math.round(window.innerHeight - visual.height - visual.offsetTop));
          layer.style.setProperty('--mxp-kb', `${inset}px`);
        };
        visual.addEventListener('resize', syncKeyboard);
        visual.addEventListener('scroll', syncKeyboard);
        syncKeyboard();
      }
      if (preview) {
        const events: Record<string, PairingEvent> = {
          waiting: { kind: 'waiting' },
          'waiting-offline': { kind: 'offline' },
          declined: declinedEvent(),
          expired: expiredEvent(),
          'network-error': networkEvent(),
        };
        if (preview === 'revoked') paint(endedView());
        else report(events[preview]);
        return;
      }
      if (autoAsk) start();
      else paint(endedView());
    };
    if (document.body) mount();
    else window.addEventListener('DOMContentLoaded', mount, { once: true });
  };
};
