// First-run / host-picker screen of the Mixdog phone app. This page is the only
// UI bundled into the app: scan the PC's QR or enter its 6-digit code,
// remember the host, then navigate the WebView to the relay's
// `/d/<deviceId>/` page. Everything after that is the relay web app. The
// layout (pairing-ui.ts) is one full-screen column shared by every step.
import { BarcodeFormat, BarcodeScanner } from '@capacitor-mlkit/barcode-scanning';
import { App } from '@capacitor/app';
import { Browser } from '@capacitor/browser';
import { Capacitor, CapacitorHttp } from '@capacitor/core';
import { Preferences } from '@capacitor/preferences';
import {
  DEFAULT_RELAY_ORIGIN,
  emptyHostBook,
  extractPairingLink,
  parseCodeInput,
  redeemCode,
  readHostBook,
  type HostBook,
} from './hosts.ts';
import { createNativeFetch } from './native-fetch.ts';
import { openHostFlow } from './open-host.ts';
import { originsOfBook } from './origins.ts';
import { nativeAppInfo } from '../../desktop/src/shared/native-app.ts';
import {
  previewFromLocation,
  renderPairing,
  STRINGS,
  stateForPreview,
  trackKeyboardInset,
  viewFor,
  type Action,
  type ResultKind,
  type ScreenState,
  type Step,
  type UpdatePhase,
} from './pairing-ui.ts';

/** Code redemption goes through the native HTTP stack: the bundled page is a
 *  different origin from the relay, and a relay without the endpoint answers
 *  without CORS headers, which the WebView would report as a network failure
 *  instead of "update the PC". */
const nativeFetch = createNativeFetch((options) => CapacitorHttp.request(options));
const relayFetch: typeof fetch = (input, init) =>
  Capacitor.isNativePlatform() ? nativeFetch(input, init) : fetch(input, init);

const HOSTS_KEY = 'mixdog.hosts';

/** The native self-update bridge (MixdogAppUpdater). Android only; the update
 *  state lives natively, this screen only mirrors it. */
interface AppUpdateReply {
  status: string;
  version?: string;
  receivedBytes?: number;
  totalBytes?: number;
  dismissed?: boolean;
}
type UpdateCall = (method: string, args?: unknown) => Promise<unknown>;
/** Statuses the pairing screen offers an update for. */
const OFFERABLE_STATUSES = new Set(['available', 'downloading', 'ready', 'needs-permission', 'installing', 'failed']);
/** Fallback when the in-app update cannot run and the native side has no URL. */
const RELEASES_URL = 'https://github.com/tribgames/mixdog/releases';

async function updateBridge(method: string, args?: unknown): Promise<unknown> {
  const info = nativeAppInfo() as unknown as { call?: UpdateCall } | null;
  if (!info?.call) throw new Error('Native bridge unavailable.');
  return info.call(method, args);
}

const korean = navigator.language.toLowerCase().startsWith('ko');
const strings = korean ? STRINGS.ko : STRINGS.en;
document.documentElement.lang = korean ? 'ko' : 'en';

const screen = document.getElementById('screen') as HTMLElement;
trackKeyboardInset(screen);
let book: HostBook = emptyHostBook();
let ui: ScreenState = { step: 'start' };
let codeValue = '';
let previewing = false;
// The user pressed "Download update": the flow runs download → install.
let updateRequested = false;
// Boot is opening the saved host; a late update offer must not interrupt it.
let launching = false;
// Last native update status seen, to tell a finished download from a re-read.
let lastUpdateStatus = '';
let redeeming = false;
// Bumped by Cancel: a redemption that finishes later must not save or navigate.
let pairingAttempt = 0;
/** How long the bundled screen may sit on "waiting" after asking to open the
 *  relay page; a page that loads replaces this one well before that. */
const NAVIGATION_TIMEOUT_MS = 20_000;
let navigationWatchdog = 0;
// Reopening a saved PC keeps #screen blank (the page background) until the
// picker is actually needed; this stays false until the first render.
let drawn = false;
// Navigation to the saved host was requested.
let navigating = false;

function render(): void {
  drawn = true;
  renderPairing(
    screen,
    { view: viewFor(ui, strings), state: ui, strings, codeValue },
    hooks
  );
}

function go(step: Step, extra: { result?: ResultKind; error?: string } = {}): void {
  ui = { ...ui, step, result: extra.result, error: extra.error ?? '', busy: false };
  render();
}

async function loadBook(): Promise<void> {
  book = readHostBook((await Preferences.get({ key: HOSTS_KEY })).value);
}

async function saveBook(): Promise<void> {
  await Preferences.set({ key: HOSTS_KEY, value: JSON.stringify(book) });
}

/** Tell the native side which relay origins may load (it persists them and
 *  refuses navigation to anything else). Must finish before navigating. */
async function syncOrigins(): Promise<void> {
  try {
    await nativeAppInfo()?.call?.('setAllowedOrigins', { origins: originsOfBook(book) });
  } catch {
    // Without the bridge the native side keeps its last list.
  }
}

async function openHost(
  url: string,
  redeemed?: { name: string; ticket: string },
  attempt?: number
): Promise<void> {
  await openHostFlow(
    {
      getBook: () => book,
      setBook: (next) => {
        book = next;
      },
      saveBook,
      syncOrigins,
      isCurrent: () => attempt === undefined || attempt === pairingAttempt,
      onRedeemed: (name) => {
        ui = { ...ui, pc: name || undefined };
        go('waiting');
      },
      navigate: (target) => {
        navigating = true;
        window.location.href = target;
        // A refused navigation (origin not allowed, handed to the system
        // browser) leaves this page alive: end the wait with an error + retry.
        window.clearTimeout(navigationWatchdog);
        navigationWatchdog = window.setTimeout(() => {
          if (attempt !== undefined && attempt !== pairingAttempt) return;
          if (!drawn || ui.step === 'waiting' || ui.step === 'waiting-offline') go('result', { result: 'network-error' });
        }, NAVIGATION_TIMEOUT_MS);
      },
      now: Date.now,
    },
    url,
    redeemed
  );
}

/** Code entry: redeem at the relay, then open the host, which asks the PC
 *  for permission. */
async function connectWithCode(): Promise<void> {
  const code = parseCodeInput(codeValue);
  if (!code || redeeming) return;
  redeeming = true;
  const attempt = ++pairingAttempt;
  // Immediate pending state: input and button wait for the one redemption.
  ui = { ...ui, busy: true };
  render();
  try {
    const result = await redeemCode(DEFAULT_RELAY_ORIGIN, code, relayFetch);
    if (attempt !== pairingAttempt) return;
    if (result.ok) {
      await openHost(result.link.url, { name: result.name, ticket: result.ticket }, attempt);
    } else if (result.reason === 'invalid') {
      go('code', { error: strings.codeInvalid });
    } else if (result.reason === 'rate-limited') {
      go('code', { error: strings.codeLimited.replace('{s}', String(result.retryAfter ?? 60)) });
    } else if (result.reason === 'outdated') {
      go('result', { result: 'outdated' });
    } else {
      go('result', { result: 'network-error' });
    }
  } finally {
    if (attempt === pairingAttempt) {
      redeeming = false;
      ui = { ...ui, busy: false };
    }
  }
}

function isInstallPageUrl(text: string): boolean {
  try {
    const url = new URL(text.trim());
    return url.protocol === 'https:' && /^\/app\/?$/u.test(url.pathname);
  } catch {
    return false;
  }
}

async function connectFrom(text: string): Promise<void> {
  const link = extractPairingLink(text);
  if (!link) {
    // The PC's phone tab shows the install-page QR (`<relay>/app`); pairing
    // from there is by code, so take the user straight to the code step.
    if (isInstallPageUrl(text)) {
      codeValue = '';
      go('code', { error: strings.installQr });
      return;
    }
    go('start', { error: strings.notLink });
    return;
  }
  await openHost(link.url);
}

async function scan(): Promise<void> {
  try {
    if (!(await BarcodeScanner.isSupported()).supported) {
      go('result', { result: 'scan-unavailable' });
      return;
    }
    if ((await BarcodeScanner.requestPermissions()).camera !== 'granted') {
      go('result', { result: 'camera-off' });
      return;
    }
    // Android scans through a Play services module that may not be on the
    // phone yet; fetch it first instead of opening a scanner that is missing.
    if (
      Capacitor.getPlatform() === 'android' &&
      !(await BarcodeScanner.isGoogleBarcodeScannerModuleAvailable()).available
    ) {
      go('start', { error: strings.preparing });
      await BarcodeScanner.installGoogleBarcodeScannerModule();
      return;
    }
    const { barcodes } = await BarcodeScanner.scan({ formats: [BarcodeFormat.QrCode] });
    const value = barcodes[0]?.rawValue ?? '';
    if (value) await connectFrom(value);
  } catch (error) {
    // Closing the scanner is not a failure.
    if (!/cancel/iu.test(String((error as Error)?.message ?? error))) {
      go('start', { error: strings.scanFailed });
    }
  }
}

/** Mirror the native update state into the screen. */
function applyUpdate(state: AppUpdateReply | null): void {
  const version = state?.version;
  if (!state || !version || state.dismissed || !OFFERABLE_STATUSES.has(state.status)) {
    if (ui.update) ui = { ...ui, update: undefined };
    return;
  }
  // A finished download ('ready', or 'needs-permission' waiting on settings) offers Install.
  const phase: UpdatePhase =
    state.status === 'downloading' || (state.status === 'available' && updateRequested)
      ? 'downloading'
      : state.status === 'ready' || state.status === 'needs-permission'
        ? 'downloaded'
        : state.status === 'installing'
          ? 'installing'
          : state.status === 'failed'
            ? 'failed'
            : 'available';
  const percent =
    phase === 'downloading' && state.totalBytes && state.receivedBytes !== undefined
      ? Math.min(100, Math.floor((state.receivedBytes / state.totalBytes) * 100))
      : undefined;
  const current = ui.update;
  if (current?.version === version && current.phase === phase && current.percent === percent) return;
  ui = { ...ui, update: { version, phase, percent } };
}

async function readUpdate(method: string, args?: unknown): Promise<AppUpdateReply | null> {
  try {
    const state = (await updateBridge(method, args)) as AppUpdateReply | null;
    return state && typeof state.status === 'string' ? state : null;
  } catch {
    return null;
  }
}

/** The native lookup/download changed: refresh the offer, and carry on with an
 *  update the user already asked for. */
async function onUpdateEvent(): Promise<void> {
  await advanceUpdate(await readUpdate('getAppUpdate'));
}

async function advanceUpdate(state: AppUpdateReply | null): Promise<void> {
  const previous = lastUpdateStatus;
  lastUpdateStatus = state?.status ?? '';
  if (!updateRequested) {
    if (launching) return;
    const before = ui.update;
    applyUpdate(state);
    if (ui.step === 'start' && ui.update !== before) render();
    return;
  }
  if (!state || state.status === 'failed') {
    // No automatic browser: the screen offers retry and "Get in browser".
    updateRequested = false;
    if (state) applyUpdate(state);
    else if (ui.update) ui = { ...ui, update: { version: ui.update.version, phase: 'failed' } };
    render();
    return;
  }
  if (state.status === 'ready') {
    if (previous === 'installing') {
      // The installer closed without replacing the app: the button works again.
      updateRequested = false;
    } else if (previous !== 'ready') {
      // Download finished, or back from the "install unknown apps" settings.
      const next = await readUpdate('installAppUpdate');
      lastUpdateStatus = next?.status ?? lastUpdateStatus;
      state = next ?? state;
    }
  }
  applyUpdate(state);
  render();
}

/** Last resort when the in-app update cannot run: the release APK in the browser. */
async function openUpdateInBrowser(): Promise<void> {
  updateRequested = false;
  let opened = false;
  try {
    opened = (await updateBridge('openAppUpdateInBrowser')) === true;
  } catch {
    // Without the bridge, fall through to the releases page.
  }
  if (!opened) await Browser.open({ url: RELEASES_URL });
  applyUpdate(await readUpdate('getAppUpdate'));
  render();
}

async function getUpdate(): Promise<void> {
  updateRequested = true;
  // Already downloaded, or back from the settings screen without the permission: install.
  if (lastUpdateStatus === 'ready' || lastUpdateStatus === 'needs-permission') {
    await advanceUpdate(await readUpdate('installAppUpdate'));
    return;
  }
  lastUpdateStatus = 'available';
  await advanceUpdate(await readUpdate('startAppUpdate'));
}

function dismissUpdate(): void {
  const version = ui.update?.version;
  updateRequested = false;
  if (version) void readUpdate('dismissAppUpdate', { version });
  ui = { ...ui, update: undefined };
}

const manage = new URLSearchParams(window.location.search).has('manage');

function onAction(id: Action['id']): void {
  if (previewing) return;
  switch (id) {
    case 'scan':
      void scan();
      break;
    case 'enter-code':
      codeValue = '';
      go('code');
      break;
    case 'connect':
      void connectWithCode();
      break;
    case 'cancel':
      if (ui.step === 'waiting' || ui.step === 'waiting-offline') window.stop();
      pairingAttempt += 1;
      redeeming = false;
      window.clearTimeout(navigationWatchdog);
      go('start');
      break;
    case 'retry':
      go('start');
      break;
    case 'update-get':
    case 'update-retry':
      if (ui.update?.phase !== 'downloading' && ui.update?.phase !== 'installing') void getUpdate();
      break;
    case 'update-browser':
      void openUpdateInBrowser();
      break;
    case 'update-later':
      dismissUpdate();
      if (!manage && book.last) void openHost(book.last);
      else render();
      break;
  }
}

const hooks = {
  onAction,
  onCodeInput(digits: string) {
    codeValue = digits;
  },
};

/** `mixdog://pair?link=<pairing link>` (and plain https pairing links). */
function linkFromAppUrl(url: string): string {
  try {
    return new URL(url).searchParams.get('link') ?? url;
  } catch {
    return url;
  }
}

async function boot(): Promise<void> {
  // Screenshot switch: `?mxPairingPreview=<state>` renders one step with no
  // network, only when localStorage `mixdog.debug.pairingPreview` is "1".
  const preview = previewFromLocation(window.location.search, window.localStorage);
  if (preview) {
    previewing = true;
    ui = stateForPreview(preview, strings);
    render();
    return;
  }
  await loadBook();
  // With a saved PC and nothing to manage, the picker would only flash while
  // the origins sync and the page loads: draw it only if something needs it.
  if (manage || !book.last) render();
  await syncOrigins();
  void App.addListener('appUrlOpen', ({ url }) => void connectFrom(linkFromAppUrl(url)));

  // Only Android sideloads: iOS updates arrive through TestFlight. The native
  // side owns the release lookup; the launch only reads its cached state (a
  // notification Allow / Deny lands here too and must not wait on the network)
  // and a lookup that finishes later arrives as a `mixdognativeupdate` event.
  if (Capacitor.getPlatform() === 'android') {
    window.addEventListener('mixdognativeupdate', () => void onUpdateEvent());
    const cached = await readUpdate('getAppUpdate');
    lastUpdateStatus = cached?.status ?? '';
    applyUpdate(cached);
  }
  if (ui.update) render();
  if (!manage && !ui.update && book.last) {
    launching = true;
    try {
      await openHost(book.last);
    } catch {
      // Opening the saved PC failed: fall through to the picker.
    }
    launching = false;
    if (!navigating && !drawn) render();
  }
}

void boot();
