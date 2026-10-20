// Boots the real main.ts under jsdom with the Capacitor plugins stubbed, and
// watches #screen: reopening a saved PC must never flash the picker.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import test from 'node:test';
import { JSDOM } from 'jsdom';

const ID = '0a1b2c3d-4e5f-6071-8293-a4b5c6d7e8f9';
const HOST = `https://relay.example.com/d/${ID}/`;
const SAVED = JSON.stringify({
  hosts: [{ url: HOST, deviceId: ID, name: 'Desk', lastOpenedAt: 1 }],
  last: HOST,
});
const ID2 = 'f9e8d7c6-b5a4-4938-8271-605f4e3d2c1b';
const OFFICE = `https://relay.example.com/d/${ID2}/`;
// Two PCs; Desk was opened last.
const SAVED_TWO = JSON.stringify({
  hosts: [
    { url: HOST, deviceId: ID, name: 'Desk', lastOpenedAt: 2 },
    { url: OFFICE, deviceId: ID2, name: 'Office', lastOpenedAt: 1 },
  ],
  last: HOST,
});

// Native HTTP answers the relay's presence lookup from `__mx.presence`; with
// none set the relay is unreachable.
const STUBS: Record<string, string> = {
  '@capacitor/app': 'export const App = { addListener: async () => ({ remove() {} }) };',
  '@capacitor/browser': 'export const Browser = { open: async () => {} };',
  '@capacitor/core':
    'export const Capacitor = { getPlatform: () => globalThis.__mx.platform, isNativePlatform: () => true };' +
    'export const CapacitorHttp = { request: async (o) => { globalThis.__mx.requests.push(o.url);' +
    ' if (!globalThis.__mx.presence) throw new Error("offline");' +
    ' return { status: 200, data: JSON.stringify({ online: globalThis.__mx.presence }) }; } };',
  '@capacitor/preferences':
    'export const Preferences = {' +
    ' get: async () => ({ value: globalThis.__mx.saved }),' +
    ' set: async ({ value }) => { if (globalThis.__mx.saveFails) throw new Error("disk"); globalThis.__mx.stored = value; } };',
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
  screen: HTMLElement;
  mx: { requests: string[]; stored?: string };
}

let runs = 0;
async function boot(options: {
  saved?: string;
  search?: string;
  platform?: string;
  update?: unknown;
  saveFails?: boolean;
  presence?: Record<string, boolean>;
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
  const mx = {
    platform: options.platform ?? 'web',
    saved: options.saved ?? null,
    saveFails: options.saveFails,
    presence: options.presence,
    requests: [] as string[],
    stored: undefined as string | undefined,
  };
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, __mx: mx });
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
    screen,
    mx,
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

test('a manage request shows the picker with the saved PC to pick, even with a saved PC', async () => {
  const b = await boot({ saved: SAVED, search: '?manage', settle: (x) => x.actions().length > 0 });
  assert.deepEqual(b.actions(), ['open-pc', 'scan', 'enter-code']);
  assert.equal(b.navigations.length, 0);
});

test('a single saved PC opens without asking the relay anything', async () => {
  const b = await boot({ saved: SAVED, presence: { [ID]: false }, settle: (x) => x.navigations.length > 0 });
  assert.equal(b.navigations.length, 1);
  assert.deepEqual(b.mx.requests, []);
});

test('with several saved PCs, an online last PC still opens straight away', async () => {
  const b = await boot({
    saved: SAVED_TWO,
    presence: { [ID]: true, [ID2]: false },
    settle: (x) => x.navigations.length > 0,
  });
  assert.equal(b.navigations.length, 1);
  assert.equal(b.everDrawn(), false);
  assert.deepEqual(b.mx.requests, ['https://relay.example.com/pair-code/presence'], 'one lookup per relay');
});

test('with several saved PCs, an offline last PC lands on the saved-PC list and a tap opens another', async () => {
  const b = await boot({
    saved: SAVED_TWO,
    presence: { [ID]: false, [ID2]: true },
    settle: (x) => x.actions().length > 0,
  });
  assert.equal(b.navigations.length, 0, 'the offline PC is not opened');
  assert.deepEqual(b.actions(), ['open-pc', 'open-pc', 'scan', 'enter-code']);
  const rows = [...b.screen.querySelectorAll<HTMLElement>('.mxp-pc')];
  assert.deepEqual(
    rows.map((row) => [row.querySelector('.mxp-pc-name')?.textContent, row.querySelector('.mxp-pc-meta')?.textContent]),
    [
      ['Desk', 'Last used · Offline'],
      ['Office', 'Online'],
    ]
  );
  rows[1].click();
  for (let i = 0; i < 100 && b.navigations.length === 0; i += 1) await new Promise((r) => setImmediate(r));
  assert.equal(b.navigations.length, 1);
  assert.equal(JSON.parse(b.mx.stored ?? '{}').last, OFFICE, 'the tapped PC becomes the last one');
});

const settleUntil = async (done: () => boolean) => {
  for (let i = 0; i < 100 && !done(); i += 1) await new Promise((r) => setImmediate(r));
};
/** jsdom runs a history traversal on window.setTimeout(…, 0), which the
 *  harness captures: drain those synchronously, so the traversal lands before
 *  any pending save/sync microtask. */
const drainTraversal = (b: Boot) => {
  for (let zero = b.timers.filter((t) => t.ms === 0); zero.length; zero = b.timers.filter((t) => t.ms === 0)) {
    for (const timer of zero) {
      b.timers.splice(b.timers.indexOf(timer), 1);
      timer.fn();
    }
  }
};
const win = () => (globalThis as unknown as { window: Window }).window;
const backState = () => (win().history.state as { mixdogBack?: boolean } | null)?.mixdogBack;
/** MainActivity's real BACK_SCRIPT, joined from its Java string literals. */
const BACK_SCRIPT = (() => {
  const java = readFileSync(
    new URL('../android/app/src/main/java/io/mixdog/app/MainActivity.java', import.meta.url),
    'utf8'
  );
  const decl = `${/BACK_SCRIPT =([\s\S]*?)";/u.exec(java)?.[1] ?? ''}"`;
  return [...decl.matchAll(/"((?:[^"\\]|\\.)*)"/gu)].map((m) => JSON.parse(`"${m[1]}"`) as string).join('');
})();
/** One Android Back press: BACK_SCRIPT, then the page-side part of what
 *  MainActivity does with its answer ('disarmed': pop the entry, then the
 *  normal Back, which leaves this page and is out of reach here). */
const pressBack = (b: Boot): string => {
  const w = win();
  const result = new Function('window', 'history', 'location', 'setTimeout', `return ${BACK_SCRIPT}`)(
    w,
    w.history,
    w.location,
    w.setTimeout
  ) as string;
  if (result === 'disarmed') w.history.back();
  drainTraversal(b);
  return result;
};
const click = (b: Boot, action: string) =>
  (b.screen.querySelector(`[data-action="${action}"]`) as HTMLButtonElement).click();
const LIST = ['open-pc', 'open-pc', 'scan', 'enter-code'];
const offlineList = () =>
  boot({ saved: SAVED_TWO, presence: { [ID]: false, [ID2]: true }, settle: (x) => x.actions().includes('open-pc') });

test('a rapid double tap on the saved-PC list opens only the first-tapped PC', async () => {
  const b = await offlineList();
  const [desk, office] = [...b.screen.querySelectorAll<HTMLButtonElement>('.mxp-pc')];
  office.click();
  // The rows now wait, and the tapped one says so; the stale node still reaches the hook.
  const busy = b.screen.querySelector('.mxp-pc.busy');
  assert.equal(busy?.querySelector('.mxp-pc-meta')?.textContent, 'Connecting…');
  assert.ok([...b.screen.querySelectorAll<HTMLButtonElement>('.mxp-pc')].every((row) => row.disabled));
  assert.deepEqual(b.actions().filter((a) => a !== 'open-pc'), ['cancel']);
  desk.click();
  await settleUntil(() => b.navigations.length > 0);
  for (let i = 0; i < 20; i += 1) await new Promise((r) => setImmediate(r));
  assert.equal(b.navigations.length, 1);
  assert.equal(JSON.parse(b.mx.stored ?? '{}').last, OFFICE);
});

test('a saved-PC tap then Cancel never navigates and keeps the previous last PC', async () => {
  const b = await offlineList();
  b.screen.querySelectorAll<HTMLButtonElement>('.mxp-pc')[1].click();
  (b.screen.querySelector('[data-action="cancel"]') as HTMLButtonElement).click();
  for (let i = 0; i < 40; i += 1) await new Promise((r) => setImmediate(r));
  assert.equal(b.navigations.length, 0);
  assert.equal(JSON.parse(b.mx.stored ?? '{}').last, HOST, 'the cancelled choice is rolled back');
  assert.deepEqual(b.actions(), ['open-pc', 'open-pc', 'scan', 'enter-code'], 'the list takes taps again');
});

test('Back from the code step returns to the saved-PC list, and works again next time', async () => {
  const b = await offlineList();
  const base = win().history.length;
  // The test page is not the bundled origin, so the plain answer is 'none' (leave).
  assert.equal(pressBack(b), 'none', 'the plain list leaves Back to the app');
  click(b, 'enter-code');
  assert.deepEqual(b.actions(), ['connect', 'cancel']);
  assert.equal(backState(), true);
  assert.equal(pressBack(b), 'web');
  assert.deepEqual(b.actions(), LIST);
  click(b, 'enter-code');
  assert.equal(pressBack(b), 'web', 'the entry is armed again for the next Back');
  assert.deepEqual(b.actions(), LIST);
  assert.equal(win().history.length, base + 1, 'one entry of its own at most');
});

test('Back on the list with a disarmed entry drops it silently and leaves in the same press', async () => {
  const b = await offlineList();
  click(b, 'enter-code');
  click(b, 'cancel');
  assert.equal(backState(), false);
  assert.equal(pressBack(b), 'disarmed', 'native pops the entry and does the normal Back at once');
  assert.equal(win().history.state, null, 'the entry is gone');
  assert.deepEqual(b.actions(), LIST, 'nothing on screen changed');
  assert.equal(pressBack(b), 'none', 'the busy guard cleared; no entry is left to spend a press on');
  click(b, 'enter-code');
  assert.equal(pressBack(b), 'web', 'the next step arms a fresh entry');
  assert.deepEqual(b.actions(), LIST);
});

test('Back during a saved-PC open cancels it', async () => {
  const b = await offlineList();
  b.screen.querySelectorAll<HTMLButtonElement>('.mxp-pc')[1].click();
  assert.equal(backState(), true, 'an open in flight arms Back');
  assert.equal(pressBack(b), 'web');
  for (let i = 0; i < 40; i += 1) await new Promise((r) => setImmediate(r));
  assert.equal(b.navigations.length, 0);
  assert.equal(JSON.parse(b.mx.stored ?? '{}').last, HOST, 'the cancelled choice is rolled back');
  assert.deepEqual(b.actions(), LIST);
});

test('Cancel then an immediate return to the code step is not undone by a late event', async () => {
  const b = await offlineList();
  click(b, 'enter-code');
  click(b, 'cancel');
  assert.equal(backState(), false, 'the plain list disarms the entry, no traversal');
  click(b, 'enter-code');
  drainTraversal(b);
  for (let i = 0; i < 20; i += 1) await new Promise((r) => setImmediate(r));
  assert.deepEqual(b.actions(), ['connect', 'cancel']);
  assert.equal(backState(), true);
});

test('repeated steps and opens never stack history entries', async () => {
  const b = await offlineList();
  const base = win().history.length;
  for (let i = 0; i < 3; i += 1) {
    click(b, 'enter-code');
    click(b, 'cancel');
    b.screen.querySelectorAll<HTMLButtonElement>('.mxp-pc')[1].click();
    click(b, 'cancel');
  }
  assert.equal(win().history.length, base + 1);
  assert.equal(backState(), false);
});

test('with several saved PCs, a relay that cannot answer keeps opening the last PC', async () => {
  const b = await boot({ saved: SAVED_TWO, settle: (x) => x.navigations.length > 0 });
  assert.equal(b.navigations.length, 1);
  assert.equal(b.everDrawn(), false);
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

test('an automatic download in progress still opens the saved PC', async () => {
  const b = await boot({
    saved: SAVED,
    platform: 'android',
    update: { status: 'downloading', installed: '0.1.16', version: '9.9.9', auto: true },
    settle: (x) => x.navigations.length > 0,
  });
  assert.equal(b.navigations.length, 1);
});

test('a saved PC that fails to open falls back to the picker', async () => {
  const b = await boot({ saved: SAVED, saveFails: true, settle: (x) => x.actions().length > 0 });
  assert.deepEqual(b.actions(), ['open-pc', 'scan', 'enter-code']);
  assert.equal(b.navigations.length, 0);
});

test('a refused navigation ends in the retry screen after the 20 s watchdog', async () => {
  const b = await boot({ saved: SAVED, settle: (x) => x.timers.length > 0 });
  assert.equal(b.everDrawn(), false);
  assert.equal(b.timers.at(-1)?.ms, 20_000);
  b.timers.at(-1)?.fn();
  assert.deepEqual(b.actions(), ['retry', 'cancel']);
});
