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
import { checkForUpdate, type AvailableUpdate } from './update.ts';
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
} from './pairing-ui.ts';

/** Code redemption goes through the native HTTP stack: the bundled page is a
 *  different origin from the relay, and a relay without the endpoint answers
 *  without CORS headers, which the WebView would report as a network failure
 *  instead of "update the PC". */
const nativeFetch = createNativeFetch((options) => CapacitorHttp.request(options));
const relayFetch: typeof fetch = (input, init) =>
  Capacitor.isNativePlatform() ? nativeFetch(input, init) : fetch(input, init);

const HOSTS_KEY = 'mixdog.hosts';
const DISMISSED_UPDATE_KEY = 'mixdog.update.dismissed';

const korean = navigator.language.toLowerCase().startsWith('ko');
const strings = korean ? STRINGS.ko : STRINGS.en;
document.documentElement.lang = korean ? 'ko' : 'en';

const screen = document.getElementById('screen') as HTMLElement;
trackKeyboardInset(screen);
let book: HostBook = emptyHostBook();
let ui: ScreenState = { step: 'start' };
let codeValue = '';
let previewing = false;
let pendingUpdate: AvailableUpdate | null = null;
let redeeming = false;
// Bumped by Cancel: a redemption that finishes later must not save or navigate.
let pairingAttempt = 0;

function render(): void {
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
        window.location.href = target;
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

async function connectFrom(text: string): Promise<void> {
  const link = extractPairingLink(text);
  if (!link) {
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

function dismissUpdate(): void {
  if (pendingUpdate) void Preferences.set({ key: DISMISSED_UPDATE_KEY, value: pendingUpdate.version });
  ui = { ...ui, update: undefined };
  pendingUpdate = null;
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
      go('start');
      break;
    case 'retry':
      go('start');
      break;
    case 'update-get':
      if (pendingUpdate) void Browser.open({ url: pendingUpdate.apkUrl });
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

async function offerUpdate(update: AvailableUpdate): Promise<void> {
  const dismissed = (await Preferences.get({ key: DISMISSED_UPDATE_KEY })).value;
  if (dismissed === update.version) return;
  pendingUpdate = update;
  ui = { ...ui, update: { version: update.version } };
}

/** `mixdog://pair?link=<pairing link>` (and plain https pairing links). */
function linkFromAppUrl(url: string): string {
  try {
    return new URL(url).searchParams.get('link') ?? url;
  } catch {
    return url;
  }
}

const LAUNCH_UPDATE_BUDGET_MS = 600;

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
  render();
  await syncOrigins();
  void App.addListener('appUrlOpen', ({ url }) => void connectFrom(linkFromAppUrl(url)));

  // Only Android sideloads: iOS updates arrive through TestFlight.
  let update: AvailableUpdate | null = null;
  if (Capacitor.getPlatform() === 'android') {
    const info = await App.getInfo();
    // A launch that goes straight to the saved host (a notification Allow /
    // Deny lands here too) must not sit behind a slow release lookup: it gets a
    // short budget, and only the picker screen, which stays up anyway, waits
    // the full timeout.
    update = await checkForUpdate(
      info.version,
      undefined,
      !manage && book.last ? LAUNCH_UPDATE_BUDGET_MS : undefined
    );
    if (update) await offerUpdate(update);
  }
  if (ui.update) render();
  if (!manage && !ui.update && book.last) await openHost(book.last);
}

void boot();
