import WebSocket from 'ws';
import fs from 'fs';
const targets = await (await fetch('http://127.0.0.1:9343/json')).json();
const page = targets.find((t) => t.type === 'page' && !/devtools/i.test(t.url));
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
let seq = 0; const pending = new Map();
ws.on('message', (raw) => { const m = JSON.parse(raw.toString()); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
const send = (method, params = {}) => new Promise((res) => { const id = ++seq; pending.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
const evalJson = async (expr) => (await send('Runtime.evaluate', { returnByValue: true, expression: expr })).result?.result?.value;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
await send('Emulation.setDeviceMetricsOverride', { width: 733, height: 693, deviceScaleFactor: 0, mobile: false });
await wait(600);
console.log(await evalJson(`JSON.stringify((() => {
  const el = document.elementFromPoint(55, 53);
  const el2 = document.elementFromPoint(40, 53);
  const info = (e) => e ? { cls: String(e.className).slice(0,40), text: (e.textContent||'').trim().slice(0,16),
    tag: e.tagName } : null;
  const strip = document.querySelector('.workspace-tabs-shell');
  const sr = strip ? strip.getBoundingClientRect() : null;
  const tabs = strip ? [...strip.querySelectorAll('.workspace-tab')].slice(0,3).map(t => { const r = t.getBoundingClientRect(); return { text: (t.textContent||'').trim().slice(0,12), L: Math.round(r.left) }; }) : [];
  const scroller = strip ? strip.querySelector('.workspace-tabs') : null;
  return { at55: info(el), at40: info(el2),
    stripL: sr ? Math.round(sr.left) : null, tabs,
    scrollLeft: scroller ? scroller.scrollLeft : null,
    railW: (() => { const rail = document.querySelector('.activity-rail, .rail, nav[class*=rail]'); return rail ? Math.round(rail.getBoundingClientRect().width) : null; })() };
})())`));
const shot = await send('Page.captureScreenshot', { format: 'png' });
fs.writeFileSync('scripts/tmp-733-shot.png', Buffer.from(shot.result.data, 'base64'));
await send('Emulation.clearDeviceMetricsOverride');
ws.close();
