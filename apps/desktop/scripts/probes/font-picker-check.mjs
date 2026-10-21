// Settings → Theme → Fonts, checked through real input events against an isolated dev instance
// (`npm run dev:isolated`): the installed-font list must stay inside the window and scroll by
// wheel and keys, a list pick and a typed custom name must both be stored, and the reset
// button must keep padding above the card's bottom edge at the end of the scroll.
// Usage: node scripts/probes/font-picker-check.mjs --port=<cdp> --out=<png prefix> [--size=WxH] [--pick=<card ids, e.g. white,glass-flow>]
// Prints one JSON object; exits 1 when a check fails. Only changes the instance's own font setting.
import { writeFileSync } from 'node:fs';

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, '').split('=')));
const [width, height] = (args.size ?? '').split('x').map(Number);
const list = await (await fetch(`http://127.0.0.1:${args.port}/json/list`)).json();
const page = list.find((p) => p.type === 'page' && /^http:\/\/127\.0\.0\.1:\d+\/$/.test(p.url));
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve) => (ws.onopen = resolve));
let seq = 0;
const waiting = new Map();
ws.onmessage = (message) => {
  const data = JSON.parse(message.data);
  waiting.get(data.id)?.(data);
};
const send = (method, params = {}) =>
  new Promise((resolve) => {
    const id = ++seq;
    waiting.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
  });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const ev = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.result.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails));
  return r.result.result.value;
};
const shot = async (name) => {
  const r = await send('Page.captureScreenshot', { format: 'png' });
  if (args.out) writeFileSync(`${args.out}-${name}.png`, Buffer.from(r.result.data, 'base64'));
};
const click = async ({ x, y }) => {
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  await sleep(250);
};
const key = async (name, code) => {
  await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: name, code: name, windowsVirtualKeyCode: code });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: name, code: name, windowsVirtualKeyCode: code });
  await sleep(60);
};
const stored = () => ev(`JSON.parse(localStorage.getItem('mixdog.desktop.fonts.v1') || '{}')`);
const centerOf = (selector, nth = 0) =>
  ev(
    `(() => { const e = [...document.querySelectorAll(${JSON.stringify(selector)})].at(${nth}); const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`
  );
const fontInputs = `input.appearance-font-input`;

if (width) await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });

// Setup: leave onboarding, open Settings on the Theme page (labels are the Korean UI's).
await ev(`(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const btn = (t) => [...document.querySelectorAll('button')].filter((b) => b.textContent.trim() === t || b.getAttribute('aria-label') === t);
  if (!document.querySelector('input.appearance-font-input')) {
    if (btn('설정 건너뛰기').length) { btn('설정 건너뛰기').at(-1).click(); await sleep(600); }
    if (btn('설정 건너뛰기').length) { btn('설정 건너뛰기').at(-1).click(); await sleep(600); }
    btn('설정 열기')[0].click(); await sleep(700);
    btn('테마').at(-1).click(); await sleep(700);
  }
})()`);
for (const id of (args.pick ?? '').split(',').filter(Boolean)) {
  await ev(
    `(async () => { document.querySelector('.skin-card[data-skin="${id}"]').click(); await new Promise((r) => setTimeout(r, 900)); })()`
  );
}

const checks = {};
const info = {};
info.window = await ev(
  `({ w: innerWidth, h: innerHeight, dataset: { ...document.documentElement.dataset }, scheme: getComputedStyle(document.documentElement).colorScheme, plate: JSON.parse(localStorage.getItem('mixdog.desktop.skin.v1') ?? 'null'), bg: getComputedStyle(document.querySelector('.settings-group-body')).backgroundColor })`
);

// 1. Reset button at the end of the scroll.
info.foot = await ev(`(() => {
  const b = document.querySelector('.settings-group-body .skin-foot button');
  let p = b.parentElement;
  while (p && !['auto', 'scroll'].includes(getComputedStyle(p).overflowY)) p = p.parentElement;
  b.scrollIntoView({ block: 'end' });
  p.scrollTop = p.scrollHeight;
  const card = b.closest('.settings-group-body').getBoundingClientRect(), r = b.getBoundingClientRect(), s = p.getBoundingClientRect();
  return { gapToCard: Math.round((card.bottom - r.bottom) * 10) / 10, inScroller: r.top >= s.top && r.bottom <= s.bottom, clickable: document.elementFromPoint(r.left + r.width / 2, r.bottom - 2) === b || b.contains(document.elementFromPoint(r.left + r.width / 2, r.bottom - 2)) };
})()`);
checks.resetNotClipped = info.foot.gapToCard >= 12 && info.foot.inScroller && info.foot.clickable;
await sleep(200);
await shot('foot');

// 2. The code-font list opened by a real click: inside the window, bounded, wheel-scrollable.
await ev(`document.querySelectorAll(${JSON.stringify(fontInputs)})[1].scrollIntoView({ block: 'center' })`);
await sleep(200);
await click(await centerOf(fontInputs, 1));
await sleep(400);
const menu = `[role=listbox]`;
info.menu = await ev(
  `(() => { const m = document.querySelector(${JSON.stringify(menu)}); if (!m) return null; const r = m.getBoundingClientRect(); return { options: m.querySelectorAll('[role=option]').length, top: r.top, bottom: r.bottom, height: r.height, scrollHeight: m.scrollHeight, clientHeight: m.clientHeight, bg: getComputedStyle(m).backgroundColor }; })()`
);
await shot('open');
checks.listInWindowAndBounded = Boolean(
  info.menu &&
    info.menu.top >= 0 &&
    info.menu.bottom <= info.window.h &&
    info.menu.height <= 240 &&
    info.menu.scrollHeight > info.menu.clientHeight
);
if (info.menu) {
  const at = await ev(
    `(() => { const r = document.querySelector(${JSON.stringify(menu)}).getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`
  );
  const pageTop = await ev(
    `(() => { let p = document.querySelector(${JSON.stringify(fontInputs)}).parentElement; while (p && !['auto', 'scroll'].includes(getComputedStyle(p).overflowY)) p = p.parentElement; return p.scrollTop; })()`
  );
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: at.x, y: at.y });
  for (let i = 0; i < 5; i++) {
    await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: at.x, y: at.y, deltaX: 0, deltaY: 120 });
    await sleep(80);
  }
  await sleep(250);
  info.wheel = await ev(
    `(() => { const m = document.querySelector(${JSON.stringify(menu)}); let p = document.querySelector(${JSON.stringify(fontInputs)}).parentElement; while (p && !['auto', 'scroll'].includes(getComputedStyle(p).overflowY)) p = p.parentElement; return { open: !!m, listScrollTop: m?.scrollTop, pageScrollTop: p.scrollTop }; })()`
  );
  info.wheel.pageScrollTopBefore = pageTop;
  checks.wheelScrollsList = info.wheel.open && info.wheel.listScrollTop > 0 && info.wheel.pageScrollTop === pageTop;
  await shot('wheeled');
  for (let i = 0; i < 40; i++) await key('ArrowDown', 40);
  info.keys = await ev(
    `(() => { const m = document.querySelector(${JSON.stringify(menu)}); const a = m?.querySelector('[role=option][data-active=true]'); if (!a) return null; const r = a.getBoundingClientRect(), mr = m.getBoundingClientRect(); return { active: a.textContent, visible: r.top >= mr.top - 1 && r.bottom <= mr.bottom + 1 }; })()`
  );
  checks.keysScrollList = Boolean(info.keys?.visible);
  // 3a. Pick an installed font by click: stored, list closes.
  const option = await ev(
    `(() => { const m = document.querySelector(${JSON.stringify(menu)}); const o = [...m.querySelectorAll('[role=option]')].find((e) => { const r = e.getBoundingClientRect(), mr = m.getBoundingClientRect(); return r.top >= mr.top && r.bottom <= mr.bottom; }); const r = o.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, name: o.textContent }; })()`
  );
  await click(option);
  info.pick = {
    wanted: option.name,
    stored: (await stored()).mono,
    listClosed: !(await ev(`!!document.querySelector(${JSON.stringify(menu)})`)),
  };
  checks.pickInstalled = info.pick.stored === option.name && info.pick.listClosed;
} else {
  checks.wheelScrollsList = false;
  checks.keysScrollList = false;
  checks.pickInstalled = false;
}

// 3b. A typed custom name (not installed): applies on Enter.
await click(await centerOf(fontInputs, 0));
await ev(`document.querySelectorAll(${JSON.stringify(fontInputs)})[0].select()`);
await send('Input.insertText', { text: 'My Custom Face' });
await sleep(150);
await key('Enter', 13);
info.custom = { ui: (await stored()).ui };
checks.typedCustomName = info.custom.ui === 'My Custom Face';
await shot('typed');

const failed = Object.entries(checks)
  .filter(([, ok]) => !ok)
  .map(([name]) => name);
console.log(JSON.stringify({ checks, failed, info }, null, 1));
ws.close();
process.exit(failed.length ? 1 : 0);
