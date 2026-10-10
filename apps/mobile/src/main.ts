// First-run / host-picker screen of the Mixdog phone app. This page is the only
// UI bundled into the app: scan the desktop's QR (or paste its pairing link),
// remember the host, then navigate the WebView to the relay's
// `/d/<deviceId>/` page. Everything after that is the relay web app.
import { BarcodeFormat, BarcodeScanner } from '@capacitor-mlkit/barcode-scanning';
import { App } from '@capacitor/app';
import { Browser } from '@capacitor/browser';
import { Capacitor } from '@capacitor/core';
import { Preferences } from '@capacitor/preferences';
import {
  emptyHostBook,
  extractPairingLink,
  forgetHost,
  readHostBook,
  rememberHost,
  type HostBook,
} from './hosts.ts';
import { originsOfBook } from './origins.ts';
import { checkForUpdate, type AvailableUpdate } from './update.ts';
import { nativeAppInfo } from '../../desktop/src/shared/native-app.ts';

const HOSTS_KEY = 'mixdog.hosts';
const DISMISSED_UPDATE_KEY = 'mixdog.update.dismissed';

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const status = (text: string, failed = false): void => {
  const line = $('status');
  line.textContent = text;
  line.dataset.failed = failed ? '1' : '';
};

let book: HostBook = emptyHostBook();

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

async function openHost(url: string): Promise<void> {
  const link = extractPairingLink(url);
  if (!link) return;
  book = rememberHost(book, link, Date.now());
  await saveBook();
  await syncOrigins();
  status('Opening…');
  window.location.href = link.url;
}

async function connectFrom(text: string): Promise<void> {
  const link = extractPairingLink(text);
  if (!link) {
    status('That is not a Mixdog pairing link.', true);
    return;
  }
  await openHost(link.url);
}

async function scan(): Promise<void> {
  try {
    if (!(await BarcodeScanner.isSupported()).supported) {
      status('QR scanning is not available here. Paste the pairing link instead.', true);
      return;
    }
    if ((await BarcodeScanner.requestPermissions()).camera !== 'granted') {
      status('Camera permission is off. Allow it in Settings or paste the pairing link.', true);
      return;
    }
    const { barcodes } = await BarcodeScanner.scan({ formats: [BarcodeFormat.QrCode] });
    const value = barcodes[0]?.rawValue ?? '';
    if (value) await connectFrom(value);
  } catch (error) {
    // Closing the scanner is not a failure.
    if (!/cancel/iu.test(String((error as Error)?.message ?? error))) {
      status('Could not scan. Paste the pairing link instead.', true);
    }
  }
}

function renderHosts(): void {
  const list = $('hosts');
  list.textContent = '';
  $('hosts-section').hidden = book.hosts.length === 0;
  for (const host of book.hosts) {
    const row = document.createElement('div');
    row.className = 'host';
    const open = document.createElement('button');
    open.className = 'host-open';
    open.textContent = host.name;
    open.addEventListener('click', () => void openHost(host.url));
    const forget = document.createElement('button');
    forget.className = 'host-forget';
    forget.textContent = 'Forget';
    forget.addEventListener('click', () => {
      book = forgetHost(book, host.url);
      void saveBook().then(syncOrigins).then(renderHosts);
    });
    row.append(open, forget);
    list.append(row);
  }
}

async function offerUpdate(update: AvailableUpdate): Promise<void> {
  const dismissed = (await Preferences.get({ key: DISMISSED_UPDATE_KEY })).value;
  if (dismissed === update.version) return;
  $('update-text').textContent = `Mixdog ${update.version} is available.`;
  $('update').hidden = false;
  $('update-get').addEventListener('click', () => void Browser.open({ url: update.apkUrl }));
  $('update-later').addEventListener('click', () => {
    $('update').hidden = true;
    void Preferences.set({ key: DISMISSED_UPDATE_KEY, value: update.version });
  });
}

/** `mixdog://pair?link=<pairing link>` (and plain https pairing links). */
function linkFromAppUrl(url: string): string {
  try {
    return new URL(url).searchParams.get('link') ?? url;
  } catch {
    return url;
  }
}

async function boot(): Promise<void> {
  await loadBook();
  renderHosts();
  await syncOrigins();
  const manage = new URLSearchParams(window.location.search).has('manage');
  $('scan').addEventListener('click', () => void scan());
  $('connect').addEventListener('click', () => void connectFrom(($('link') as HTMLInputElement).value));
  void App.addListener('appUrlOpen', ({ url }) => void connectFrom(linkFromAppUrl(url)));

  // Only Android sideloads: iOS updates arrive through TestFlight.
  let update: AvailableUpdate | null = null;
  if (Capacitor.getPlatform() === 'android') {
    const info = await App.getInfo();
    update = await checkForUpdate(info.version);
    if (update) await offerUpdate(update);
  }
  const prompting = update !== null && !$('update').hidden;
  if (!manage && !prompting && book.last) await openHost(book.last);
  else if (!manage && prompting) {
    // Launch continues to the last host once the prompt is answered.
    for (const id of ['update-get', 'update-later']) {
      $(id).addEventListener('click', () => {
        if (book.last) void openHost(book.last);
      });
    }
  }
}

void boot();
