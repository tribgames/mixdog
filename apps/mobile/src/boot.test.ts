// Boots the real main.ts under jsdom with the Capacitor plugins stubbed, and
// watches #screen: reopening a saved PC must never flash the picker.
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';
import { JSDOM } from 'jsdom';

const ID = '0a1b2c3d-4e5f-6071-8293-a4b5c6d7e8f9';
const HOST = `https://relay.example.com/d/${ID}/`;
const SAVED = JSON.stringify({
  hosts: [{ url: HOST, deviceId: ID, name: 'Desk', lastOpenedAt: 1 }],
  last: HOST,
});

const STUBS: Record<string, string> = {
  '@capacitor/app': 'export const App = { addListener: async () => ({ remove() {} }) };',
  '@capacitor/browser': 'export const Browser = { open: async () => {} };',
  '@capacitor/core':
    'export const Capacitor = { getPlatform: () => globalThis.__mx.platform };' +
    'export const CapacitorHttp = { request: async () => { throw new Error("offline"); } };',
  '@capacitor/preferences':
    'export const Preferences = {' +
    ' get: async () => ({ value: globalThis.__mx.saved }),' +
    ' set: async () => { if (globalThis.__mx.saveFails) throw new Error("disk"); } };',
  '@capacitor-mlkit/barcode-scanning':
    'export const BarcodeFormat = { QrCode: "QR_CODE" }; export const BarcodeScanner = {};',
};
registerHooks({
  resolve(specifier, context, next) {
    return specifier in STUBS
      ? { url: `mixdog-stub:${specifier}`, format: 'module', shortCircuit: true }
      : next(specifier, context);
  },
  load(url, context, next) {
    const stub = STUBS[url.replace('mixdog-stub:', '')];
    return url.startsWith('mixdog-stub:') ? { format: 'module', source: stub, shortCircuit: true } : next(url, context);
  },
});

interface Boot {
  actions: () => string[];
  everDrawn: () => boolean;
  navigations: string[];
  timers: { fn: () => void; ms: number }[];
}

let runs = 0;
async function boot(options: {
  saved?: string;
  search?: string;
  platform?: string;
  update?: unknown;
  saveFails?: boolean;
  settle: (b: Boot) => boolean;
}): Promise<Boot> {
  const navigations: string[] = [];
  const timers: Boot['timers'] = [];
  const { VirtualConsole } = (await import('jsdom')) as unknown as {
    VirtualConsole: new () => { on(e: string, f: (m: Error) => void): void };
  };
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', (error) => {
    if (/navigation/iu.test(error.message)) navigations.push(error.message);
  });
  const dom = new JSDOM('<!doctype html><div id="screen"></div>', {
    url: `https://app.local/${options.search ?? ''}`,
    virtualConsole,
  } as Record<string, unknown>);
  const win = dom.window as unknown as Record<string, unknown>;
  win.setTimeout = (fn: () => void, ms: number) => timers.push({ fn, ms });
  win.mixdogNative = {
    platform: 'android',
    call: async (method: string) => (method === 'getAppUpdate' ? (options.update ?? null) : null),
  };
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    __mx: { platform: options.platform ?? 'web', saved: options.saved ?? null, saveFails: options.saveFails },
  });
  Object.defineProperty(globalThis, 'navigator', { value: { language: 'en-US', userAgent: '' }, configurable: true });

  const screen = dom.window.document.getElementById('screen') as HTMLElement;
  let drawn = false;
  const seen = (): boolean => screen.querySelector('button') !== null;
  const observer = new dom.window.MutationObserver(() => {
    drawn ||= seen();
  });
  observer.observe(screen, { childList: true, subtree: true });

  runs += 1;
  await import(`./main.ts?run=${runs}`);
  const result: Boot = {
    actions: () => [...screen.querySelectorAll('button')].map((b) => (b as HTMLElement).dataset.action ?? ''),
    everDrawn: () => drawn || seen(),
    navigations,
    timers,
  };
  for (let i = 0; i < 100 && !options.settle(result); i += 1) await new Promise((r) => setImmediate(r));
  return result;
}

test('reopening with a saved PC draws no picker and goes straight to the host', async () => {
  const b = await boot({ saved: SAVED, settle: (x) => x.navigations.length > 0 });
  assert.equal(b.navigations.length, 1);
  assert.equal(b.everDrawn(), false);
});

test('first run without a saved PC shows the picker and does not navigate', async () => {
  const b = await boot({ settle: (x) => x.actions().length > 0 });
  assert.deepEqual(b.actions(), ['scan', 'enter-code']);
  assert.equal(b.navigations.length, 0);
});

test('a manage request shows the picker even with a saved PC', async () => {
  const b = await boot({ saved: SAVED, search: '?manage', settle: (x) => x.actions().length > 0 });
  assert.deepEqual(b.actions(), ['scan', 'enter-code']);
  assert.equal(b.navigations.length, 0);
});

test('an update offer shows instead of opening the saved PC', async () => {
  const b = await boot({
    saved: SAVED,
    platform: 'android',
    update: { status: 'available', version: '9.9.9' },
    settle: (x) => x.actions().length > 0,
  });
  assert.ok(b.actions().includes('update-get'));
  assert.equal(b.navigations.length, 0);
});

test('a saved PC that fails to open falls back to the picker', async () => {
  const b = await boot({ saved: SAVED, saveFails: true, settle: (x) => x.actions().length > 0 });
  assert.deepEqual(b.actions(), ['scan', 'enter-code']);
  assert.equal(b.navigations.length, 0);
});

test('a refused navigation ends in the retry screen after the 20 s watchdog', async () => {
  const b = await boot({ saved: SAVED, settle: (x) => x.timers.length > 0 });
  assert.equal(b.everDrawn(), false);
  assert.equal(b.timers.at(-1)?.ms, 20_000);
  b.timers.at(-1)?.fn();
  assert.deepEqual(b.actions(), ['retry', 'cancel']);
});
