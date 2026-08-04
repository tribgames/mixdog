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
await send('Emulation.setDeviceMetricsOverride', { width: 518, height: 652, deviceScaleFactor: 0, mobile: false });
await wait(700);
console.log(await evalJson(`JSON.stringify((() => {
  const h = document.querySelector('.workspace > .session-header');
  if (!h) return { header: null };
  const cs = getComputedStyle(h);
  const h1 = h.querySelector('h1');
  const badge = h.querySelector('.session-project-badge');
  const status = h.querySelector('.session-header-status');
  return {
    pos: cs.position,
    h1: h1 ? getComputedStyle(h1).display : null,
    badge: badge ? getComputedStyle(badge).display : null,
    status: status ? getComputedStyle(status).display : null,
    rect: (() => { const r = h.getBoundingClientRect(); return { t: Math.round(r.top), r: Math.round(innerWidth - r.right), w: Math.round(r.width) }; })(),
  };
})())`));
const shot = await send('Page.captureScreenshot', { format: 'png' });
fs.writeFileSync('scripts/tmp-518-shot.png', Buffer.from(shot.result.data, 'base64'));
await send('Emulation.clearDeviceMetricsOverride');
ws.close();
